import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import {
  availableStock,
  isLowStock,
  planAdjustment,
  planFulfilment,
  planReceipt,
  planRelease,
  planReservation,
  planSale,
  assertInvariants,
} from "./inventory.rules.js";
import type {
  InventoryAuditLog,
  InventoryItem,
  InventoryRepository,
  Paginated,
  StockMovementHistory,
} from "./inventory.repository.js";
import type {
  AdjustStockInput,
  CreateInventoryItemInput,
  FulfilStockInput,
  ListAuditLogsQuery,
  ListInventoryQuery,
  ListMovementsQuery,
  ReceiveStockInput,
  ReleaseStockInput,
  ReserveStockInput,
  ReturnStockInput,
  SellStockInput,
  StockMovementTypeValue,
  UpdateInventoryItemInput,
} from "./inventory.schema.js";

/** Item plus derived read-model fields the API exposes. */
export interface InventoryItemView extends InventoryItem {
  available: number;
  lowStock: boolean;
}

export function toInventoryItemView(item: InventoryItem): InventoryItemView {
  return {
    ...item,
    available: availableStock(item),
    lowStock: isLowStock(item),
  };
}

export class InventoryService {
  constructor(private readonly repository: InventoryRepository) {}

  async list(query: ListInventoryQuery): Promise<Paginated<InventoryItemView>> {
    const { items, total } = await this.repository.list(query);
    return { items: items.map(toInventoryItemView), total };
  }

  async getById(id: string): Promise<InventoryItemView> {
    const item = await this.repository.findById(id);
    if (!item) throw new NotFoundError(`Inventory item '${id}' was not found`);
    return toInventoryItemView(item);
  }

  async getBySku(sku: string): Promise<InventoryItemView> {
    const item = await this.repository.findBySku(sku);
    if (!item) throw new NotFoundError(`No inventory item exists for SKU '${sku}'`);
    return toInventoryItemView(item);
  }

  /** One stock record per product; both keys are checked before inserting. */
  async create(input: CreateInventoryItemInput): Promise<InventoryItemView> {
    const existing = await this.repository.findBySku(input.sku);
    if (existing) {
      throw new ConflictError(`Inventory for SKU '${input.sku}' already exists`);
    }

    const forProduct = await this.repository.findByProductId(input.productId);
    if (forProduct) {
      throw new ConflictError(
        `Inventory for product '${input.productId}' already exists as SKU '${forProduct.sku}'`,
      );
    }

    return toInventoryItemView(await this.repository.create(input));
  }

  /** Stock for a product, or null when it has not been provisioned yet. */
  async getByProductId(productId: string): Promise<InventoryItemView | null> {
    const item = await this.repository.findByProductId(productId);
    return item ? toInventoryItemView(item) : null;
  }

  /**
   * Patches any column and records who changed what. The 404 and the
   * invariant check both happen inside the repository transaction, so a
   * concurrent reservation cannot slip between the check and the write.
   */
  async update(
    id: string,
    input: UpdateInventoryItemInput,
    actor?: string,
  ): Promise<InventoryItemView> {
    const updated = await this.repository.update(id, input, {
      actor,
      validate: (current) => {
        // A hand-edited quantity must still cover what is already promised.
        if (input.quantity !== undefined) {
          assertInvariants({ quantity: input.quantity, reserved: current.reserved });
        }
      },
    });

    return toInventoryItemView(updated);
  }

  async remove(id: string): Promise<void> {
    const item = await this.getById(id);
    if (item.reserved > 0) {
      throw new ConflictError(
        `Cannot delete inventory with ${item.reserved} reserved units outstanding`,
      );
    }
    await this.repository.delete(id);
  }

  async listMovements(
    id: string,
    query: ListMovementsQuery,
  ): Promise<Paginated<StockMovementHistory>> {
    await this.getById(id);
    return this.repository.listMovements(id, query);
  }

  /** Who changed which field, and from what to what. */
  async listAuditLogs(
    id: string,
    query: ListAuditLogsQuery,
  ): Promise<Paginated<InventoryAuditLog>> {
    await this.getById(id);
    return this.repository.listAuditLogs(id, query);
  }

  /** Promise stock to an order without shipping it yet. */
  reserve(id: string, input: ReserveStockInput): Promise<InventoryItemView> {
    return this.applyChange(id, "RESERVATION", input.quantity, input, (item) =>
      planReservation(item, input.quantity),
    );
  }

  /** Return previously reserved stock to the available pool. */
  release(id: string, input: ReleaseStockInput): Promise<InventoryItemView> {
    return this.applyChange(id, "RELEASE", input.quantity, input, (item) =>
      planRelease(item, input.quantity),
    );
  }

  /** Ship reserved stock: drops both on-hand and reserved. */
  fulfil(id: string, input: FulfilStockInput): Promise<InventoryItemView> {
    return this.applyChange(id, "OUTBOUND", input.quantity, input, (item) =>
      planFulfilment(item, input.quantity),
    );
  }

  /**
   * Sell stock that was never reserved — a walk-in or single-step checkout.
   * Recorded as OUTBOUND, same as a fulfilment: physically, goods left.
   * Two-step order flows should still go reserve → fulfil so the units are
   * held while payment settles.
   */
  sell(id: string, input: SellStockInput): Promise<InventoryItemView> {
    return this.applyChange(id, "OUTBOUND", input.quantity, input, (item) =>
      planSale(item, input.quantity),
    );
  }

  /** Book in a delivery. */
  receive(id: string, input: ReceiveStockInput): Promise<InventoryItemView> {
    return this.applyChange(id, "INBOUND", input.quantity, input, (item) =>
      planReceipt(item, input.quantity),
    );
  }

  /**
   * Take back sold units. The level change is identical to a delivery; only
   * the ledger entry differs, so returned goods can be separated from
   * purchased ones when reading the history.
   */
  acceptReturn(id: string, input: ReturnStockInput): Promise<InventoryItemView> {
    return this.applyChange(id, "RETURN", input.quantity, input, (item) =>
      planReceipt(item, input.quantity),
    );
  }

  /** Signed correction, e.g. after a stock count. */
  adjust(id: string, input: AdjustStockInput): Promise<InventoryItemView> {
    return this.applyChange(id, "ADJUSTMENT", Math.abs(input.delta), input, (item) =>
      planAdjustment(item, input.delta),
    );
  }

  /**
   * The planner runs inside the repository transaction against freshly-read
   * state, so the invariant check and the write cannot be interleaved by a
   * concurrent request.
   */
  private async applyChange(
    id: string,
    type: StockMovementTypeValue,
    movementQuantity: number,
    meta: { reason?: string | undefined; reference?: string | undefined },
    plan: (item: InventoryItem) => { quantity: number; reserved: number },
  ): Promise<InventoryItemView> {
    const updated = await this.repository.applyStockChange(id, (item) => {
      const next = plan(item);
      assertInvariants(next);
      return {
        ...next,
        movement: {
          type,
          quantity: movementQuantity,
          reason: meta.reason,
          reference: meta.reference,
        },
      };
    });

    return toInventoryItemView(updated);
  }
}
