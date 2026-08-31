import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import { logger } from "../../lib/logger.js";
import type {
  CallContext,
  InventoryClient,
  InventoryItem,
} from "../../clients/inventory.client.js";
import type { Product, ProductRepository } from "./product.repository.js";
import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
} from "./product.schema.js";

/**
 * Derived from the stock levels the inventory service reports.
 *
 * The last two are not states of the stock, and neither may be collapsed into
 * `OUT_OF_STOCK` — that would turn an infrastructure problem into a business
 * fact and stop you selling goods you actually hold:
 *   - `UNKNOWN`        — inventory could not be reached.
 *   - `UNPROVISIONED`  — inventory answered, and has no record for this
 *                        product. A create that failed halfway leaves this;
 *                        it is repairable from the product id alone.
 */
export const STOCK_STATUSES = [
  "IN_STOCK",
  "LOW_STOCK",
  "OUT_OF_STOCK",
  "UNPROVISIONED",
  "UNKNOWN",
] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** The slice of the inventory record this service republishes. */
export interface ProductStock {
  inventoryId: string;
  sku: string;
  warehouse: string;
  quantity: number;
  reserved: number;
  available: number;
  reorderLevel: number;
}

/** A product plus the stock figures owned by the inventory service. */
export interface ProductView extends Product {
  stock: ProductStock | null;
  stockStatus: StockStatus;
}

export function toStockStatus(
  item: InventoryItem | undefined | null,
  reachable = true,
): StockStatus {
  if (!item) return reachable ? "UNPROVISIONED" : "UNKNOWN";
  // Checked before `lowStock`, which is also true at zero.
  if (item.available <= 0) return "OUT_OF_STOCK";
  return item.lowStock ? "LOW_STOCK" : "IN_STOCK";
}

export function toProductView(
  product: Product,
  item: InventoryItem | undefined | null,
  reachable = true,
): ProductView {
  return {
    ...product,
    stock: item
      ? {
          inventoryId: item.id,
          sku: item.sku,
          warehouse: item.warehouse,
          quantity: item.quantity,
          reserved: item.reserved,
          available: item.available,
          reorderLevel: item.reorderLevel,
        }
      : null,
    stockStatus: toStockStatus(item, reachable),
  };
}

export interface ListProductsView {
  items: ProductView[];
  total: number;
}

/**
 * Business rules for products. Deliberately free of Express and Prisma types
 * so it can be unit-tested directly and reused from a queue consumer or CLI.
 *
 * Stock lives in the inventory service. Reads here enrich products with it on
 * a best-effort basis; writes provision and maintain the matching inventory
 * record. There is no distributed transaction, so multi-service writes are
 * ordered so that a failure leaves the *product* row consistent, and are
 * undone with an explicit compensating call where that is not possible.
 */
export class ProductService {
  constructor(
    private readonly repository: ProductRepository,
    private readonly inventory: InventoryClient,
  ) {}

  async list(query: ListProductsQuery, context?: CallContext): Promise<ListProductsView> {
    const { items, total } = await this.repository.list(query);
    if (items.length === 0) return { items: [], total };

    // One bulk call for the whole page rather than one per product.
    const { found, reachable } = await this.readStockForPage(
      items.map((product) => product.id),
      context,
    );

    return {
      items: items.map((product) =>
        toProductView(product, found.get(product.id), reachable),
      ),
      total,
    };
  }

  async getById(id: string, context?: CallContext): Promise<ProductView> {
    const product = await this.getProduct(id);
    const { item, reachable } = await this.lookUpStock(product, context);
    return toProductView(product, item, reachable);
  }

  /**
   * Creates the product, then provisions its inventory record.
   *
   * The product is written first because it owns the id the inventory record
   * is keyed by; nothing needs to exist before it. If provisioning then
   * fails, the product is deleted so the caller sees a clean failure rather
   * than a listing with no stock behind it.
   *
   * Should that compensating delete also fail — or the process die in
   * between — the leftover is a product with no inventory record, which
   * reads as `UNPROVISIONED` and can be repaired later from the product id
   * alone. That recoverability is the point of keying on `productId`.
   */
  async create(input: CreateProductInput, context?: CallContext): Promise<ProductView> {
    const existing = await this.repository.findBySku(input.sku);
    if (existing) throw new ConflictError(`A product with SKU '${input.sku}' already exists`);

    const { stock, ...fields } = input;
    const product = await this.repository.create(fields);

    try {
      const item = await this.inventory.create(
        { ...stock, sku: product.sku, productId: product.id },
        context,
      );
      return toProductView(product, item);
    } catch (error) {
      // A failed provisioning call does not mean nothing was written. A
      // timeout — or a 5xx raised after the far side had already committed —
      // is an *ambiguous* outcome: the inventory record may exist regardless.
      // Assuming it does not is what strands a row nothing points at, and
      // since its SKU is unique over there, that row then blocks the retry
      // too. So ask inventory rather than infer.
      //
      // Inventory is undone first here, the opposite of `remove()`. There the
      // product is the row a caller can see, so it goes first; here both rows
      // are going away and the stranded one is the one holding the SKU. If
      // this step fails the product delete below still runs, leaving exactly
      // the residue that was left before — never worse.
      await this.compensate(
        () => this.discardStock(product.id, context),
        { productId: product.id },
        "inventory_rollback_failed",
      );
      await this.compensate(
        () => this.repository.delete(product.id),
        { productId: product.id },
        "product_rollback_failed",
      );
      throw error;
    }
  }

  /**
   * A SKU change has to reach the inventory record too, or the two services
   * disagree about what the item is called. Inventory goes first: it can
   * reject the new SKU as a duplicate, and finding that out before the
   * product row moves keeps the failure clean.
   */
  async update(
    id: string,
    input: UpdateProductInput,
    context?: CallContext,
  ): Promise<ProductView> {
    const current = await this.getProduct(id);
    const skuChanged = Boolean(input.sku && input.sku !== current.sku);

    // Only looked up when it is actually needed: the inventory record's own
    // id is required to patch it, and `productId` is how we find it.
    const item = skuChanged ? await this.readStock(current, context) : null;

    if (skuChanged) {
      const conflicting = await this.repository.findBySku(input.sku as string);
      if (conflicting && conflicting.id !== id) {
        throw new ConflictError(`A product with SKU '${input.sku}' already exists`);
      }
      if (item) await this.inventory.update(item.id, { sku: input.sku }, context);
    }

    try {
      const product = await this.repository.update(id, input);
      return toProductView(product, item ?? (await this.readStock(product, context)));
    } catch (error) {
      if (item) {
        await this.compensate(
          () => this.inventory.update(item.id, { sku: current.sku }, context),
          { productId: id, inventoryId: item.id },
          "inventory_sku_rollback_failed",
        );
      }
      throw error;
    }
  }

  /**
   * Deletes the product and its inventory record.
   *
   * Refuses while stock or reservations remain: the inventory record carries
   * the movement ledger and audit trail, and dropping it would destroy
   * history that outlives the product listing. Archiving the product
   * (`status: ARCHIVED`) is the non-destructive way to retire it.
   *
   * The product goes first. A leftover inventory row is invisible to callers
   * and can be reconciled later, whereas a product pointing at deleted stock
   * would surface as a broken read.
   */
  async remove(id: string, context?: CallContext): Promise<void> {
    const product = await this.getProduct(id);
    const item = await this.inventory.findByProductId(product.id, context);

    if (item && (item.quantity > 0 || item.reserved > 0)) {
      throw new ConflictError(
        `Product '${id}' still holds stock (${item.quantity} on hand, ${item.reserved} reserved). ` +
          "Clear the stock or archive the product instead.",
      );
    }

    await this.repository.delete(id);

    if (item) {
      await this.compensate(
        () => this.inventory.delete(item.id, context),
        { productId: id, inventoryId: item.id },
        "orphaned_inventory_cleanup_failed",
      );
    }
  }

  private async getProduct(id: string): Promise<Product> {
    const product = await this.repository.findById(id);
    if (!product) throw new NotFoundError(`Product '${id}' was not found`);
    return product;
  }

  /**
   * Stock is supplementary: a product read must still succeed when inventory
   * is unavailable. `reachable` is what separates "inventory says there is no
   * record" from "inventory never answered", which look identical otherwise.
   */
  private async lookUpStock(
    product: Product,
    context?: CallContext,
  ): Promise<{ item: InventoryItem | null; reachable: boolean }> {
    try {
      return { item: await this.inventory.findByProductId(product.id, context), reachable: true };
    } catch (error) {
      logger.warn({ err: error, productId: product.id }, "inventory_lookup_failed");
      return { item: null, reachable: false };
    }
  }

  /** Convenience wrapper for the paths that only need the record itself. */
  private async readStock(
    product: Product,
    context?: CallContext,
  ): Promise<InventoryItem | null> {
    return (await this.lookUpStock(product, context)).item;
  }

  private async readStockForPage(
    productIds: string[],
    context?: CallContext,
  ): Promise<{ found: Map<string, InventoryItem>; reachable: boolean }> {
    try {
      return { found: await this.inventory.findByProductIds(productIds, context), reachable: true };
    } catch (error) {
      logger.warn({ err: error, count: productIds.length }, "inventory_bulk_lookup_failed");
      return { found: new Map(), reachable: false };
    }
  }

  /**
   * Undoes a provisioning call whose outcome is unknown.
   *
   * The lookup is the whole point: `create` may have committed before the
   * failure reached us, and inventory is the only thing that can say whether
   * it did. A record that was never written needs no undoing, so this is safe
   * to run after every failed create, ambiguous or not.
   */
  private async discardStock(productId: string, context?: CallContext): Promise<void> {
    const item = await this.inventory.findByProductId(productId, context);
    if (!item) return;

    await this.inventory.delete(item.id, context);
    logger.warn({ productId, inventoryId: item.id }, "orphaned_inventory_reclaimed");
  }

  /**
   * Runs a best-effort undo. A failure here cannot be signalled to the caller
   * — the operation it is compensating for has already failed — so it is
   * logged at `error` for a reconciliation job to pick up.
   */
  private async compensate(
    action: () => Promise<unknown>,
    ids: { productId: string; inventoryId?: string },
    event: string,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      logger.error({ err: error, ...ids }, event);
    }
  }
}
