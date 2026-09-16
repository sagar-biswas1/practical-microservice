import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AxiosInstance, AxiosResponse } from 'axios';

import { InsufficientStockException } from './insufficient-stock.exception';
import { InjectInventoryHttp } from './inventory.constants';
import type {
  InventoryDispatch,
  InventoryPort,
  StockChangeOptions,
} from './inventory.port';
import {
  MAX_BULK_LINES,
  type CallContext,
  type InventoryItem,
  type StockFailure,
  type StockLine,
} from './inventory.types';

/** Correlation id, propagated so one id spans the whole call chain. */
const REQUEST_ID_HEADER = 'x-request-id';

/** Who to attribute the change to in inventory's audit trail. */
const ACTOR_HEADER = 'x-actor-id';

/** The envelope every inventory endpoint answers with. */
interface Envelope<T> {
  success: boolean;
  data: T;
  error?: {
    message?: string;
    code?: string;
    details?: Array<Record<string, unknown>>;
  };
}

/**
 * Inventory over HTTP: the adapter behind both ports.
 *
 * Registered under `INVENTORY_PORT` always, and under `INVENTORY_DISPATCH`
 * while that side is configured for HTTP. When the dispatch side moves to
 * RabbitMQ only the second registration changes — this class keeps serving
 * the reservations and lookups a caller has to wait on.
 *
 * Calls go direct rather than through the api-gateway: the gateway's
 * stock-mutation policy is admin-only and exists to keep end users off these
 * endpoints, which is not what this is. Service-to-service traffic on the
 * internal network, the same route the product service takes.
 */
@Injectable()
export class HttpInventoryAdapter implements InventoryPort, InventoryDispatch {
  private readonly logger = new Logger(HttpInventoryAdapter.name);

  constructor(
    /** Configured and supplied by `InventoryModule`; see `INVENTORY_HTTP`. */
    @InjectInventoryHttp() private readonly http: AxiosInstance,
  ) {}

  /**
   * Holds stock for a whole cart in one all-or-nothing call.
   *
   * The batch either reserves everything it asked for or reserves nothing, so
   * a failure leaves no partial hold for the cart to unwind. A refusal comes
   * back as `InsufficientStockException` carrying every rejected line.
   *
   * `reference` should identify the cart — inventory writes it onto each
   * ledger row, and it is what makes the matching release traceable.
   */
  reserveMany(
    items: StockLine[],
    reference: string,
    options: StockChangeOptions = {},
  ): Promise<InventoryItem[]> {
    return this.bulk('reserve', items, reference, options);
  }

  /**
   * Hands a cart's reservations back — cancellation, abandonment, or a
   * checkout that fell through.
   *
   * Strict on the inventory side: releasing more than is held is a conflict,
   * not a no-op, so retrying a release that already succeeded raises
   * `InsufficientStockException` rather than silently inflating stock. Callers
   * driving this from a cleanup path should treat that as "already released"
   * and check the per-line `code` rather than retrying blindly.
   */
  async releaseMany(
    items: StockLine[],
    reference: string,
    options: StockChangeOptions = {},
  ): Promise<void> {
    // Returns nothing, because the AMQP adapter beside this one cannot know
    // the resulting stock levels. A caller that needs them is on the wrong
    // port.
    await this.bulk('release', items, reference, options);
  }

  /**
   * Moves a hold from one reference to another.
   *
   * Two calls, in this order out of necessity: reserving under the new
   * reference first would need the stock to be available twice over, which
   * for the shopper who is holding it is exactly the case that fails.
   *
   * The cost is a window — measured in the round trip between the two calls —
   * in which the units are unheld and another shopper can take them. Losing
   * that race surfaces as `InsufficientStockException` after the hold has been
   * put back under `from`, so the caller is told and nothing is stranded.
   *
   * Inventory tracks `reserved` as a single counter and records the reference
   * only on the ledger row, so the window closes properly only when inventory
   * grows an atomic `POST /inventory/bulk/transfer`. At that point this method
   * becomes one call and no caller changes.
   */
  async transferHold(
    items: StockLine[],
    from: string,
    to: string,
    options: StockChangeOptions = {},
  ): Promise<void> {
    if (items.length === 0) return;

    await this.bulk('release', items, from, {
      ...options,
      reason: options.reason ?? 'Hold transferred out',
    });

    try {
      await this.bulk('reserve', items, to, {
        ...options,
        reason: options.reason ?? 'Hold transferred in',
      });
    } catch (error) {
      // Put the hold back where it was. If this fails too the units are
      // simply unheld: the cart still lists them, so its expiry will try to
      // release them, get a conflict, and retire — no stock is stranded.
      try {
        await this.bulk('reserve', items, from, {
          ...options,
          reason: 'Rolling back a failed hold transfer',
        });
      } catch (rollbackError: unknown) {
        const message =
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
        this.logger.error(
          `could not restore the hold for ${from} after a failed transfer to ${to}: ${message}`,
        );
      }
      throw error;
    }
  }

  /** Stock for one product, or null when it has not been provisioned yet. */
  async findByProductId(
    productId: string,
    context?: CallContext,
  ): Promise<InventoryItem | null> {
    const query = new URLSearchParams({ productId, limit: '1' });
    const items = await this.request<InventoryItem[]>(
      'GET',
      `/api/v1/inventory?${query.toString()}`,
      context,
    );
    return items[0] ?? null;
  }

  /**
   * Bulk lookup keyed by `productId`, for pricing or displaying a whole cart
   * without a request per line. Products with no stock record are simply
   * absent from the map.
   */
  async findByProductIds(
    productIds: string[],
    context?: CallContext,
  ): Promise<Map<string, InventoryItem>> {
    const found = new Map<string, InventoryItem>();
    if (productIds.length === 0) return found;

    // Chunked because the filter is a query string with a server-side cap.
    for (let offset = 0; offset < productIds.length; offset += MAX_BULK_LINES) {
      const chunk = productIds.slice(offset, offset + MAX_BULK_LINES);
      const query = new URLSearchParams({
        productIds: chunk.join(','),
        limit: String(MAX_BULK_LINES),
      });

      const items = await this.request<InventoryItem[]>(
        'GET',
        `/api/v1/inventory?${query.toString()}`,
        context,
      );

      for (const item of items) found.set(item.productId, item);
    }

    return found;
  }

  /** Shared body of the two bulk transitions; they differ only in the path. */
  private async bulk(
    transition: 'reserve' | 'release',
    items: StockLine[],
    reference: string,
    options: StockChangeOptions,
  ): Promise<InventoryItem[]> {
    if (items.length === 0) return [];

    // Refused here rather than spending a round trip on a 422. Inventory
    // rejects duplicates too; catching it locally gives a clearer message and
    // keeps a caller from assuming the quantities were summed.
    const productIds = new Set(items.map((line) => line.productId));
    if (productIds.size !== items.length) {
      throw new BadRequestException(
        'Each productId may appear only once; combine duplicates into a single line',
      );
    }
    if (items.length > MAX_BULK_LINES) {
      throw new BadRequestException(
        `A cart may hold at most ${MAX_BULK_LINES} distinct products`,
      );
    }

    const updated = await this.request<InventoryItem[]>(
      'POST',
      `/api/v1/inventory/bulk/${transition}`,
      options.context,
      {
        items,
        reference,
        ...(options.reason ? { reason: options.reason } : {}),
      },
    );

    this.logger.log(`${transition}d ${items.length} line(s) for ${reference}`);
    return updated;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    context?: CallContext,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (context?.requestId) headers[REQUEST_ID_HEADER] = context.requestId;
    if (context?.actor) headers[ACTOR_HEADER] = context.actor;

    let response: AxiosResponse<Envelope<T>>;
    try {
      response = await this.http.request<Envelope<T>>({
        method,
        url: path,
        headers,
        ...(body !== undefined ? { data: body } : {}),
      });
    } catch (error: unknown) {
      // `validateStatus` swallows every status, so reaching here means the
      // request never completed: connection refused, DNS failure, or timeout.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`inventory unreachable: ${message}`);
      throw new ServiceUnavailableException('Inventory service is unreachable');
    }

    if (response.status >= 200 && response.status < 300) {
      return response.data.data;
    }

    throw this.toException(response);
  }

  /**
   * Translates an inventory failure into this service's vocabulary. A 5xx
   * downstream is a 503 here — the caller's request was fine, a dependency
   * was not — while a 4xx means the payload this service sent was rejected.
   */
  private toException(response: AxiosResponse<Envelope<unknown>>): Error {
    const message = response.data?.error?.message ?? `HTTP ${response.status}`;

    if (response.status >= 500) {
      return new ServiceUnavailableException(
        `Inventory service failed: ${message}`,
      );
    }

    // The one status a caller is expected to handle rather than treat as a
    // fault: the cart is fine, the stock behind it is not.
    if (response.status === 409) {
      return new InsufficientStockException(
        message,
        toStockFailures(response.data?.error?.details),
      );
    }

    return new BadRequestException(
      `Inventory rejected the request: ${message}`,
    );
  }
}

/**
 * Narrows inventory's error details to the per-line shape.
 *
 * Details are shaped by the other service, so anything unrecognisable is
 * dropped rather than trusted: a caller reading `failures` gets lines it can
 * act on, never half-populated ones.
 */
function toStockFailures(details: unknown): StockFailure[] {
  if (!Array.isArray(details)) return [];

  return details.flatMap((detail: unknown) => {
    if (typeof detail !== 'object' || detail === null) return [];
    const record = detail as Record<string, unknown>;
    if (typeof record.productId !== 'string') return [];

    return [
      {
        productId: record.productId,
        code: typeof record.code === 'string' ? record.code : 'CONFLICT',
        message:
          typeof record.message === 'string'
            ? record.message
            : 'Line was rejected',
        ...(typeof record.requested === 'number'
          ? { requested: record.requested }
          : {}),
        ...(typeof record.available === 'number'
          ? { available: record.available }
          : {}),
        ...(typeof record.reserved === 'number'
          ? { reserved: record.reserved }
          : {}),
      },
    ];
  });
}
