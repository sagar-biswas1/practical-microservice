import type {
  InventoryAuditLog,
  InventoryItem,
  Prisma,
  StockMovementHistory,
} from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { NotFoundError } from "../../errors/app-error.js";
import { AUDITED_FIELDS } from "./inventory.schema.js";
import type {
  CreateInventoryItemInput,
  ListAuditLogsQuery,
  ListInventoryQuery,
  ListMovementsQuery,
  StockMovementTypeValue,
  UpdateInventoryItemInput,
} from "./inventory.schema.js";

export type { InventoryAuditLog, InventoryItem, StockMovementHistory };

/** One column's before/after, as recorded in the audit trail. */
export interface FieldChange {
  field: string;
  oldValue: string;
  newValue: string;
}

/** Everything an update needs beyond the patch itself. */
export interface UpdateContext {
  /** Who requested the change; stamped on every audit row. */
  actor?: string | undefined;
  /**
   * Checks the patch against the freshly-read row *inside* the transaction,
   * throwing a domain error if the result would break an invariant. Mirrors
   * `StockChangePlanner`: validation must see committed data.
   */
  validate: (current: InventoryItem) => void;
}

/**
 * Compares a patch against the stored row, ignoring absent and unchanged
 * fields so a no-op PATCH leaves no audit noise behind.
 */
export function diffInventoryItem(
  current: InventoryItem,
  patch: UpdateInventoryItemInput,
): FieldChange[] {
  const changes: FieldChange[] = [];

  for (const field of AUDITED_FIELDS) {
    const next = patch[field];
    if (next === undefined || next === current[field]) continue;
    changes.push({
      field,
      oldValue: String(current[field]),
      newValue: String(next),
    });
  }

  return changes;
}

export interface Paginated<T> {
  items: T[];
  total: number;
}

/** What a stock operation wants to happen, computed from the *current* row. */
export interface StockChangePlan {
  quantity: number;
  reserved: number;
  movement: {
    type: StockMovementTypeValue;
    quantity: number;
    reason?: string | undefined;
    reference?: string | undefined;
  };
}

/**
 * Receives the freshly-read row and returns the desired next state.
 * Invoked *inside* the transaction, so validation sees committed data.
 */
export type StockChangePlanner = (item: InventoryItem) => StockChangePlan;

export interface InventoryRepository {
  list(query: ListInventoryQuery): Promise<Paginated<InventoryItem>>;
  findById(id: string): Promise<InventoryItem | null>;
  findBySku(sku: string): Promise<InventoryItem | null>;
  findByProductId(productId: string): Promise<InventoryItem | null>;
  create(input: CreateInventoryItemInput): Promise<InventoryItem>;
  /** Atomically re-reads, validates, writes, and records the field changes. */
  update(
    id: string,
    input: UpdateInventoryItemInput,
    context: UpdateContext,
  ): Promise<InventoryItem>;
  delete(id: string): Promise<void>;
  listMovements(
    itemId: string,
    query: ListMovementsQuery,
  ): Promise<Paginated<StockMovementHistory>>;
  listAuditLogs(
    itemId: string,
    query: ListAuditLogsQuery,
  ): Promise<Paginated<InventoryAuditLog>>;
  /** Atomically re-reads, validates via `plan`, writes, and records history. */
  applyStockChange(
    id: string,
    plan: StockChangePlanner,
  ): Promise<InventoryItem>;
}

export class PrismaInventoryRepository implements InventoryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: ListInventoryQuery): Promise<Paginated<InventoryItem>> {
    const where: Prisma.InventoryItemWhereInput = {
      ...(query.sku
        ? { sku: { contains: query.sku, mode: "insensitive" } }
        : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.productIds ? { productId: { in: query.productIds } } : {}),
      ...(query.warehouse ? { warehouse: query.warehouse } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.inventoryItem.findMany({
        where,
        orderBy: { [query.sortBy]: query.order },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.inventoryItem.count({ where }),
    ]);

    // `available <= reorderLevel` compares two columns, which Prisma's filter
    // API cannot express; applied after the fetch.
    if (query.lowStock) {
      const lowStock = items.filter(
        (item) => item.quantity - item.reserved <= item.reorderLevel,
      );
      return { items: lowStock, total: lowStock.length };
    }

    return { items, total };
  }

  findById(id: string): Promise<InventoryItem | null> {
    return this.prisma.inventoryItem.findUnique({ where: { id } });
  }

  findBySku(sku: string): Promise<InventoryItem | null> {
    return this.prisma.inventoryItem.findUnique({ where: { sku } });
  }

  findByProductId(productId: string): Promise<InventoryItem | null> {
    return this.prisma.inventoryItem.findUnique({ where: { productId } });
  }

  async create(input: CreateInventoryItemInput): Promise<InventoryItem> {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.create({ data: input });

      if (item.quantity > 0) {
        await tx.stockMovementHistory.create({
          data: {
            itemId: item.id,
            type: "INBOUND",
            quantityChanged: item.quantity,
            lastQuantity: 0,
            reason: "Initial stock",
          },
        });
      }

      return item;
    });
  }

  update(
    id: string,
    input: UpdateInventoryItemInput,
    context: UpdateContext,
  ): Promise<InventoryItem> {
    return this.prisma.$transaction(
      async (tx) => {
        const current = await tx.inventoryItem.findUnique({ where: { id } });
        if (!current)
          throw new NotFoundError(`Inventory item '${id}' was not found`);

        // Throws a domain error if the patch would break an invariant.
        context.validate(current);

        const changes = diffInventoryItem(current, input);
        // Nothing actually differs: skip the write so `updatedAt` does not
        // move and the trail records only real changes.
        if (changes.length === 0) return current;

        const updated = await tx.inventoryItem.update({
          where: { id },
          data: input,
        });

        await tx.inventoryAuditLog.createMany({
          data: changes.map((change) => ({
            itemId: id,
            field: change.field,
            oldValue: change.oldValue,
            newValue: change.newValue,
            actor: context.actor ?? null,
          })),
        });

        // A quantity edit moves stock, so it belongs in the ledger too —
        // otherwise the movement history stops reconciling with on-hand.
        if (updated.quantity !== current.quantity) {
          await tx.stockMovementHistory.create({
            data: {
              itemId: id,
              type: "ADJUSTMENT",
              quantityChanged: Math.abs(updated.quantity - current.quantity),
              lastQuantity: current.quantity,
              reason: `Patched by ${context.actor ?? "unknown"}`,
            },
          });
        }

        return updated;
      },
      // Serializable: the read that feeds `validate` and the diff must not be
      // interleaved with a concurrent reservation.
      { isolationLevel: "Serializable" },
    );
  }

  async delete(id: string): Promise<void> {
    await this.prisma.inventoryItem.delete({ where: { id } });
  }

  async listMovements(
    itemId: string,
    query: ListMovementsQuery,
  ): Promise<Paginated<StockMovementHistory>> {
    const where: Prisma.StockMovementHistoryWhereInput = {
      itemId,
      ...(query.type ? { type: query.type } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.stockMovementHistory.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.stockMovementHistory.count({ where }),
    ]);

    return { items, total };
  }

  async listAuditLogs(
    itemId: string,
    query: ListAuditLogsQuery,
  ): Promise<Paginated<InventoryAuditLog>> {
    const where: Prisma.InventoryAuditLogWhereInput = {
      itemId,
      ...(query.field ? { field: query.field } : {}),
      ...(query.actor ? { actor: query.actor } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.inventoryAuditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.inventoryAuditLog.count({ where }),
    ]);

    return { items, total };
  }

  applyStockChange(
    id: string,
    plan: StockChangePlanner,
  ): Promise<InventoryItem> {
    return this.prisma.$transaction(
      async (tx) => {
        const current = await tx.inventoryItem.findUnique({ where: { id } });
        if (!current)
          throw new NotFoundError(`Inventory item '${id}' was not found`);

        // Throws a domain error if the change would break an invariant.
        const next = plan(current);

        const updated = await tx.inventoryItem.update({
          where: { id },
          data: { quantity: next.quantity, reserved: next.reserved },
        });

        await tx.stockMovementHistory.create({
          data: {
            itemId: id,
            type: next.movement.type,
            quantityChanged: next.movement.quantity,
            lastQuantity: current.quantity,
            reason: next.movement.reason ?? null,
            reference: next.movement.reference ?? null,
          },
        });

        return updated;
      },
      // Serializable: two concurrent reservations must not both read the same
      // pre-change level and jointly oversell the item.
      { isolationLevel: "Serializable" },
    );
  }
}
