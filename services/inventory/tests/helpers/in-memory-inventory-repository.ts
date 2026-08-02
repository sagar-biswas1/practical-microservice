import { randomUUID } from "node:crypto";
import type {
  InventoryAuditLog,
  InventoryItem,
  InventoryRepository,
  Paginated,
  StockChangePlanner,
  StockMovementHistory,
  UpdateContext,
} from "../../src/modules/inventory/inventory.repository.js";
import { diffInventoryItem } from "../../src/modules/inventory/inventory.repository.js";
import { NotFoundError } from "../../src/errors/app-error.js";
import type {
  CreateInventoryItemInput,
  ListAuditLogsQuery,
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
  private readonly movements: StockMovementHistory[] = [];
  private readonly auditLogs: InventoryAuditLog[] = [];

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
    if (query.productIds) {
      const wanted = new Set(query.productIds);
      items = items.filter((item) => wanted.has(item.productId));
    }
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

  async findByProductId(productId: string): Promise<InventoryItem | null> {
    return [...this.items.values()].find((item) => item.productId === productId) ?? null;
  }

  async create(input: CreateInventoryItemInput): Promise<InventoryItem> {
    const item = InMemoryInventoryRepository.buildItem({ ...input, id: randomUUID(), reserved: 0 });
    this.items.set(item.id, item);
    if (item.quantity > 0) {
      // Opening stock: nothing was on hand before it.
      this.recordMovement(item.id, "INBOUND", item.quantity, 0, "Initial stock");
    }
    return item;
  }

  async update(
    id: string,
    input: UpdateInventoryItemInput,
    context: UpdateContext,
  ): Promise<InventoryItem> {
    const current = this.items.get(id);
    if (!current) throw new NotFoundError(`Inventory item '${id}' was not found`);

    context.validate(current);

    const changes = diffInventoryItem(current, input);
    if (changes.length === 0) return current;

    const updated: InventoryItem = { ...current, ...input, updatedAt: new Date() };
    this.items.set(id, updated);

    for (const change of changes) {
      this.auditLogs.push({
        id: randomUUID(),
        itemId: id,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        actor: context.actor ?? null,
        createdAt: new Date(),
      });
    }

    if (updated.quantity !== current.quantity) {
      this.recordMovement(
        id,
        "ADJUSTMENT",
        Math.abs(updated.quantity - current.quantity),
        current.quantity,
        `Patched by ${context.actor ?? "unknown"}`,
      );
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    this.items.delete(id);
  }

  async listMovements(
    itemId: string,
    query: ListMovementsQuery,
  ): Promise<Paginated<StockMovementHistory>> {
    let movements = this.movements.filter((movement) => movement.itemId === itemId);
    if (query.type) movements = movements.filter((movement) => movement.type === query.type);

    const total = movements.length;
    const start = (query.page - 1) * query.limit;
    return { items: movements.slice(start, start + query.limit), total };
  }

  async listAuditLogs(
    itemId: string,
    query: ListAuditLogsQuery,
  ): Promise<Paginated<InventoryAuditLog>> {
    let logs = this.auditLogs.filter((log) => log.itemId === itemId);
    if (query.field) logs = logs.filter((log) => log.field === query.field);
    if (query.actor) logs = logs.filter((log) => log.actor === query.actor);

    const total = logs.length;
    const start = (query.page - 1) * query.limit;
    return { items: logs.slice(start, start + query.limit), total };
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
      current.quantity,
      next.movement.reason ?? null,
      next.movement.reference ?? null,
    );

    return updated;
  }

  /** `lastQuantity` is the on-hand level *before* the movement was applied. */
  private recordMovement(
    itemId: string,
    type: StockMovementHistory["type"],
    quantityChanged: number,
    lastQuantity: number,
    reason: string | null = null,
    reference: string | null = null,
  ): void {
    this.movements.push({
      id: randomUUID(),
      itemId,
      type,
      quantityChanged,
      lastQuantity,
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

  get auditLogCount(): number {
    return this.auditLogs.length;
  }
}
