import { randomUUID } from "node:crypto";
import type {
  InventoryItem,
  InventoryRepository,
  Paginated,
  StockChangePlanner,
  StockMovement,
} from "../../src/modules/inventory/inventory.repository.js";
import { NotFoundError } from "../../src/errors/app-error.js";
import type {
  CreateInventoryItemInput,
  ListInventoryQuery,
  ListMovementsQuery,
  UpdateInventoryItemInput,
} from "../../src/modules/inventory/inventory.schema.js";

/**
 * Test double for `InventoryRepository`. `applyStockChange` mirrors the real
 * read → plan → write sequence so the invariant checks are exercised exactly
 * as they run inside the Prisma transaction.
 */
export class InMemoryInventoryRepository implements InventoryRepository {
  private readonly items = new Map<string, InventoryItem>();
  private readonly movements: StockMovement[] = [];

  constructor(seed: InventoryItem[] = []) {
    for (const item of seed) this.items.set(item.id, item);
  }

  static buildItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
    const now = new Date("2026-01-01T00:00:00.000Z");
    return {
      id: randomUUID(),
      sku: "SKU-001",
      productId: randomUUID(),
      warehouse: "default",
      quantity: 100,
      reserved: 0,
      reorderLevel: 10,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  async list(query: ListInventoryQuery): Promise<Paginated<InventoryItem>> {
    let items = [...this.items.values()];

    if (query.sku) {
      const needle = query.sku.toLowerCase();
      items = items.filter((item) => item.sku.toLowerCase().includes(needle));
    }
    if (query.productId) items = items.filter((item) => item.productId === query.productId);
    if (query.warehouse) items = items.filter((item) => item.warehouse === query.warehouse);
    if (query.lowStock) {
      items = items.filter((item) => item.quantity - item.reserved <= item.reorderLevel);
    }

    items.sort((a, b) => {
      const left = a[query.sortBy];
      const right = b[query.sortBy];
      const comparison = left < right ? -1 : left > right ? 1 : 0;
      return query.order === "asc" ? comparison : -comparison;
    });

    const total = items.length;
    const start = (query.page - 1) * query.limit;
    return { items: items.slice(start, start + query.limit), total };
  }

  async findById(id: string): Promise<InventoryItem | null> {
    return this.items.get(id) ?? null;
  }

  async findBySku(sku: string): Promise<InventoryItem | null> {
    return [...this.items.values()].find((item) => item.sku === sku) ?? null;
  }

  async create(input: CreateInventoryItemInput): Promise<InventoryItem> {
    const item = InMemoryInventoryRepository.buildItem({ ...input, id: randomUUID(), reserved: 0 });
    this.items.set(item.id, item);
    if (item.quantity > 0) {
      this.recordMovement(item.id, "INBOUND", item.quantity, "Initial stock");
    }
    return item;
  }

  async update(id: string, input: UpdateInventoryItemInput): Promise<InventoryItem> {
    const current = this.items.get(id);
    if (!current) throw new NotFoundError(`Inventory item '${id}' was not found`);
    const updated: InventoryItem = { ...current, ...input, updatedAt: new Date() };
    this.items.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }

  async listMovements(
    itemId: string,
    query: ListMovementsQuery,
  ): Promise<Paginated<StockMovement>> {
    let movements = this.movements.filter((movement) => movement.itemId === itemId);
    if (query.type) movements = movements.filter((movement) => movement.type === query.type);

    const total = movements.length;
    const start = (query.page - 1) * query.limit;
    return { items: movements.slice(start, start + query.limit), total };
  }

  async applyStockChange(id: string, plan: StockChangePlanner): Promise<InventoryItem> {
    const current = this.items.get(id);
    if (!current) throw new NotFoundError(`Inventory item '${id}' was not found`);

    const next = plan(current);

    const updated: InventoryItem = {
      ...current,
      quantity: next.quantity,
      reserved: next.reserved,
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    this.recordMovement(
      id,
      next.movement.type,
      next.movement.quantity,
      next.movement.reason ?? null,
      next.movement.reference ?? null,
    );

    return updated;
  }

  private recordMovement(
    itemId: string,
    type: StockMovement["type"],
    quantity: number,
    reason: string | null = null,
    reference: string | null = null,
  ): void {
    this.movements.push({
      id: randomUUID(),
      itemId,
      type,
      quantity,
      reason,
      reference,
      createdAt: new Date(),
    });
  }

  get size(): number {
    return this.items.size;
  }

  get movementCount(): number {
    return this.movements.length;
  }
}
