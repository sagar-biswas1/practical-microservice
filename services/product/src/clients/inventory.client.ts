import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { env } from "../config/env.js";
import {
  BadRequestError,
  ConflictError,
  ServiceUnavailableError,
} from "../errors/app-error.js";
import { REQUEST_ID_HEADER, ACTOR_HEADER } from "../middlewares/request-context.js";

/**
 * The inventory service's read model, as returned over HTTP. This is a copy
 * of a contract owned by another service, not a shared type: it is allowed to
 * lag behind theirs, and only the fields listed here are relied upon.
 */
export interface InventoryItem {
  id: string;
  sku: string;
  productId: string;
  warehouse: string;
  quantity: number;
  reserved: number;
  reorderLevel: number;
  /** quantity - reserved. */
  available: number;
  /** available <= reorderLevel. */
  lowStock: boolean;
}

export interface CreateInventoryInput {
  sku: string;
  productId: string;
  warehouse?: string | undefined;
  quantity?: number | undefined;
  reorderLevel?: number | undefined;
}

export interface UpdateInventoryInput {
  sku?: string | undefined;
  warehouse?: string | undefined;
  quantity?: number | undefined;
  reorderLevel?: number | undefined;
}

/** Correlation and identity carried from the inbound request. */
export interface CallContext {
  requestId?: string | undefined;
  actor?: string | undefined;
}

export interface InventoryClient {
  create(input: CreateInventoryInput, context?: CallContext): Promise<InventoryItem>;
  findById(id: string, context?: CallContext): Promise<InventoryItem | null>;
  /** Stock for one product, or null when it has not been provisioned. */
  findByProductId(productId: string, context?: CallContext): Promise<InventoryItem | null>;
  /** Bulk lookup for list endpoints, keyed by `productId`. */
  findByProductIds(
    productIds: string[],
    context?: CallContext,
  ): Promise<Map<string, InventoryItem>>;
  update(
    id: string,
    input: UpdateInventoryInput,
    context?: CallContext,
  ): Promise<InventoryItem>;
  delete(id: string, context?: CallContext): Promise<void>;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { message?: string };
}

/** Inventory's list cap; a page larger than this cannot be enriched in one call. */
const MAX_BULK_IDS = 100;

export class HttpInventoryClient implements InventoryClient {
  private readonly http: AxiosInstance;

  constructor(
    baseUrl: string = env.INVENTORY_SERVICE_URL,
    timeoutMs: number = env.INVENTORY_TIMEOUT_MS,
    http?: AxiosInstance,
  ) {
    this.http =
      http ??
      axios.create({
        baseURL: baseUrl,
        timeout: timeoutMs,
        headers: { accept: "application/json" },
        // Every status is a normal response; only transport failures reject.
        // Status handling then lives in one place instead of being split
        // between the happy path and an error interceptor.
        validateStatus: () => true,
      });
  }

  async create(input: CreateInventoryInput, context?: CallContext): Promise<InventoryItem> {
    return this.request<InventoryItem>("POST", "/api/v1/inventory", context, input);
  }

  async findById(id: string, context?: CallContext): Promise<InventoryItem | null> {
    return this.request<InventoryItem>(
      "GET",
      `/api/v1/inventory/${encodeURIComponent(id)}`,
      context,
      undefined,
      { nullOn404: true },
    );
  }

  async findByProductId(
    productId: string,
    context?: CallContext,
  ): Promise<InventoryItem | null> {
    const query = new URLSearchParams({ productId, limit: "1" });
    const items = await this.request<InventoryItem[]>(
      "GET",
      `/api/v1/inventory?${query.toString()}`,
      context,
    );
    return items[0] ?? null;
  }

  async findByProductIds(
    productIds: string[],
    context?: CallContext,
  ): Promise<Map<string, InventoryItem>> {
    const found = new Map<string, InventoryItem>();
    if (productIds.length === 0) return found;

    // Chunked because the filter is a query string with a server-side cap.
    for (let offset = 0; offset < productIds.length; offset += MAX_BULK_IDS) {
      const chunk = productIds.slice(offset, offset + MAX_BULK_IDS);
      const query = new URLSearchParams({
        productIds: chunk.join(","),
        limit: String(MAX_BULK_IDS),
      });

      const items = await this.request<InventoryItem[]>(
        "GET",
        `/api/v1/inventory?${query.toString()}`,
        context,
      );

      for (const item of items) found.set(item.productId, item);
    }

    return found;
  }

  async update(
    id: string,
    input: UpdateInventoryInput,
    context?: CallContext,
  ): Promise<InventoryItem> {
    return this.request<InventoryItem>(
      "PATCH",
      `/api/v1/inventory/${encodeURIComponent(id)}`,
      context,
      input,
    );
  }

  async delete(id: string, context?: CallContext): Promise<void> {
    await this.request<null>(
      "DELETE",
      `/api/v1/inventory/${encodeURIComponent(id)}`,
      context,
      undefined,
      { nullOn404: true },
    );
  }

  private async request<T>(
    method: string,
    path: string,
    context?: CallContext,
    body?: unknown,
    options: { nullOn404?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    // Propagated so one correlation id — and one actor — spans both services.
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
    } catch (error) {
      // `validateStatus` swallows every status, so reaching here means the
      // request never completed: connection refused, DNS failure, or timeout.
      throw new ServiceUnavailableError("Inventory service is unreachable", error);
    }

    if (response.status === 204) return null as T;

    if (response.status >= 200 && response.status < 300) {
      return response.data.data;
    }

    if (response.status === 404 && options.nullOn404) return null as T;

    throw this.toError(response);
  }

  /**
   * Translates an inventory failure into this service's vocabulary. A 5xx
   * downstream is a 503 here — the caller's request is fine, a dependency is
   * not — while a 4xx means the payload this service sent was rejected.
   */
  private toError(response: AxiosResponse<Envelope<unknown>>): Error {
    const message = response.data?.error?.message ?? `HTTP ${response.status}`;

    if (response.status >= 500) {
      return new ServiceUnavailableError(`Inventory service failed: ${message}`);
    }

    switch (response.status) {
      case 404:
        return new ServiceUnavailableError(`Inventory record is missing: ${message}`);
      case 409:
        return new ConflictError(message);
      default:
        return new BadRequestError(`Inventory rejected the request: ${message}`);
    }
  }
}
