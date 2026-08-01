import type {
  InventoryItem,
  Prisma,
  StockMovement,
} from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { NotFoundError } from "../../errors/app-error.js";
import type {
  CreateInventoryItemInput,
  ListInventoryQuery,
  ListMovementsQuery,
  StockMovementTypeValue,
  UpdateInventoryItemInput,
} from "./inventory.schema.js";

export type { InventoryItem, StockMovement };

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
  create(input: CreateInventoryItemInput): Promise<InventoryItem>;
  update(id: string, input: UpdateInventoryItemInput): Promise<InventoryItem>;
  delete(id: string): Promise<void>;
  listMovements(itemId: string, query: ListMovementsQuery): Promise<Paginated<StockMovement>>;
  /** Atomically re-reads, validates via `plan`, writes, and records history. */
  applyStockChange(id: string, plan: StockChangePlanner): Promise<InventoryItem>;
}

export class PrismaInventoryRepository implements InventoryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: ListInventoryQuery): Promise<Paginated<InventoryItem>> {
    const where: Prisma.InventoryItemWhereInput = {
      ...(query.sku ? { sku: { contains: query.sku, mode: "insensitive" } } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
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

  async create(input: CreateInventoryItemInput): Promise<InventoryItem> {
    return this.prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.create({ data: input });

      if (item.quantity > 0) {
        await tx.stockMovement.create({
          data: {
            itemId: item.id,
            type: "INBOUND",
            quantity: item.quantity,
            reason: "Initial stock",
          },
        });
      }

      return item;
    });
  }

  update(id: string, input: UpdateInventoryItemInput): Promise<InventoryItem> {
    return this.prisma.inventoryItem.update({ where: { id }, data: input });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.inventoryItem.delete({ where: { id } });
  }

  async listMovements(
    itemId: string,
    query: ListMovementsQuery,
  ): Promise<Paginated<StockMovement>> {
    const where: Prisma.StockMovementWhereInput = {
      itemId,
      ...(query.type ? { type: query.type } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return { items, total };
  }

  applyStockChange(id: string, plan: StockChangePlanner): Promise<InventoryItem> {
    return this.prisma.$transaction(
      async (tx) => {
        const current = await tx.inventoryItem.findUnique({ where: { id } });
        if (!current) throw new NotFoundError(`Inventory item '${id}' was not found`);

        // Throws a domain error if the change would break an invariant.
        const next = plan(current);

        const updated = await tx.inventoryItem.update({
          where: { id },
          data: { quantity: next.quantity, reserved: next.reserved },
        });

        await tx.stockMovement.create({
          data: {
            itemId: id,
            type: next.movement.type,
            quantity: next.movement.quantity,
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
