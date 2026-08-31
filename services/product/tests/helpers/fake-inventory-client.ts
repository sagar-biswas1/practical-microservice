import { randomUUID } from "node:crypto";
import { ServiceUnavailableError } from "../../src/errors/app-error.js";
import type {
  CallContext,
  CreateInventoryInput,
  InventoryClient,
  InventoryItem,
  UpdateInventoryInput,
} from "../../src/clients/inventory.client.js";

type Method =
  | "create"
  | "findById"
  | "findByProductId"
  | "findByProductIds"
  | "update"
  | "delete";

/**
 * Test double for the inventory service. Records the calls it receives so
 * tests can assert on the cross-service choreography — which call happened,
 * in what order, and with which context — and can be told to fail a given
 * method to exercise the compensating paths.
 */
export class FakeInventoryClient implements InventoryClient {
  private readonly items = new Map<string, InventoryItem>();
  private readonly failing = new Set<Method>();
  private readonly failingAfter = new Set<Method>();

  readonly calls: Array<{ method: Method; context?: CallContext | undefined }> = [];

  constructor(seed: InventoryItem[] = []) {
    for (const item of seed) this.items.set(item.id, item);
  }

  static buildItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
    const quantity = overrides.quantity ?? 100;
    const reserved = overrides.reserved ?? 0;
    const reorderLevel = overrides.reorderLevel ?? 10;

    return {
      id: randomUUID(),
      sku: "SKU-001",
      productId: randomUUID(),
      warehouse: "default",
      quantity,
      reserved,
      reorderLevel,
      available: quantity - reserved,
      lowStock: quantity - reserved <= reorderLevel,
      ...overrides,
    };
  }

  /** Makes every subsequent call to `method` reject, as an outage would. */
  fail(method: Method): void {
    this.failing.add(method);
  }

  /**
   * Makes `method` apply its effect and *then* reject — the shape of a
   * timeout, where the far side committed but the caller never learned it.
   * Only the mutating methods honour this; on the read paths there is no
   * effect for the distinction to be visible in.
   */
  failAfter(method: Method): void {
    this.failingAfter.add(method);
  }

  get size(): number {
    return this.items.size;
  }

  find(id: string): InventoryItem | undefined {
    return this.items.get(id);
  }

  async create(input: CreateInventoryInput, context?: CallContext): Promise<InventoryItem> {
    this.record("create", context);

    const item = FakeInventoryClient.buildItem({
      sku: input.sku,
      productId: input.productId,
      warehouse: input.warehouse ?? "default",
      quantity: input.quantity ?? 0,
      reserved: 0,
      reorderLevel: input.reorderLevel ?? 0,
    });
    this.items.set(item.id, this.recompute(item));
    this.maybeFailAfter("create");
    return this.items.get(item.id) as InventoryItem;
  }

  async findById(id: string, context?: CallContext): Promise<InventoryItem | null> {
    this.record("findById", context);
    return this.items.get(id) ?? null;
  }

  async findByProductId(
    productId: string,
    context?: CallContext,
  ): Promise<InventoryItem | null> {
    this.record("findByProductId", context);
    return [...this.items.values()].find((item) => item.productId === productId) ?? null;
  }

  async findByProductIds(
    productIds: string[],
    context?: CallContext,
  ): Promise<Map<string, InventoryItem>> {
    this.record("findByProductIds", context);

    const wanted = new Set(productIds);
    const found = new Map<string, InventoryItem>();
    for (const item of this.items.values()) {
      if (wanted.has(item.productId)) found.set(item.productId, item);
    }
    return found;
  }

  async update(
    id: string,
    input: UpdateInventoryInput,
    context?: CallContext,
  ): Promise<InventoryItem> {
    this.record("update", context);

    const current = this.items.get(id);
    if (!current) throw new ServiceUnavailableError(`Inventory record '${id}' is missing`);

    const updated = this.recompute({ ...current, ...input });
    this.items.set(id, updated);
    return updated;
  }

  async delete(id: string, context?: CallContext): Promise<void> {
    this.record("delete", context);
    this.items.delete(id);
    this.maybeFailAfter("delete");
  }

  private record(method: Method, context?: CallContext): void {
    this.calls.push({ method, context });
    if (this.failing.has(method)) {
      throw new ServiceUnavailableError("Inventory service is unreachable");
    }
  }

  /** The `failAfter` half: same error, raised once the write has landed. */
  private maybeFailAfter(method: Method): void {
    if (this.failingAfter.has(method)) {
      throw new ServiceUnavailableError("Inventory service is unreachable");
    }
  }

  /** Keeps the derived fields consistent, exactly as the real service does. */
  private recompute(item: InventoryItem): InventoryItem {
    const available = item.quantity - item.reserved;
    return { ...item, available, lowStock: available <= item.reorderLevel };
  }
}
