import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../../src/errors/app-error.js";
import { ProductService } from "../../src/modules/product/product.service.js";
import type { ListProductsQuery } from "../../src/modules/product/product.schema.js";
import type { Product } from "../../src/modules/product/product.repository.js";
import type { InventoryItem } from "../../src/clients/inventory.client.js";
import { InMemoryProductRepository } from "../helpers/in-memory-product-repository.js";
import { FakeInventoryClient } from "../helpers/fake-inventory-client.js";

const defaultQuery: ListProductsQuery = {
  page: 1,
  limit: 20,
  sortBy: "createdAt",
  order: "desc",
};

/** A product and the inventory record it points at, correctly cross-linked. */
function linkedPair(
  productOverrides: Partial<Product> = {},
  stockOverrides: Partial<InventoryItem> = {},
): { product: Product; item: InventoryItem } {
  const product = InMemoryProductRepository.buildProduct(productOverrides);
  const item = FakeInventoryClient.buildItem({
    productId: product.id,
    sku: product.sku,
    ...stockOverrides,
  });
  return { product, item };
}

describe("ProductService", () => {
  let repository: InMemoryProductRepository;
  let inventory: FakeInventoryClient;
  let service: ProductService;

  /** Rebuilds the service around a seeded repository and inventory double. */
  const seedWith = (products: Product[], items: InventoryItem[] = []): void => {
    repository = new InMemoryProductRepository(products);
    inventory = new FakeInventoryClient(items);
    service = new ProductService(repository, inventory);
  };

  beforeEach(() => {
    seedWith([]);
  });

  describe("create", () => {
    it("persists a new product", async () => {
      const product = await service.create({
        sku: "SKU-100",
        name: "Keyboard",
        priceCents: 4999,
        currency: "USD",
        status: "ACTIVE",
      });

      expect(product.id).toBeTruthy();
      expect(product.sku).toBe("SKU-100");
      expect(repository.size).toBe(1);
    });

    it("rejects a duplicate SKU with a 409", async () => {
      const input = {
        sku: "SKU-100",
        name: "Keyboard",
        priceCents: 4999,
        currency: "USD",
        status: "ACTIVE" as const,
      };
      await service.create(input);

      await expect(service.create(input)).rejects.toThrowError(ConflictError);
      await expect(service.create(input)).rejects.toMatchObject({ statusCode: 409 });
      expect(repository.size).toBe(1);
    });
  });

  describe("getById", () => {
    it("returns an existing product", async () => {
      const seeded = InMemoryProductRepository.buildProduct();
      seedWith([seeded]);

      await expect(service.getById(seeded.id)).resolves.toMatchObject({ id: seeded.id });
    });

    it("throws NotFoundError for an unknown id", async () => {
      await expect(service.getById("missing-id")).rejects.toThrowError(NotFoundError);
      await expect(service.getById("missing-id")).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("update", () => {
    it("applies a partial patch", async () => {
      const seeded = InMemoryProductRepository.buildProduct({ name: "Old" });
      seedWith([seeded]);

      const updated = await service.update(seeded.id, { name: "New" });

      expect(updated.name).toBe("New");
      expect(updated.sku).toBe(seeded.sku);
    });

    it("allows re-submitting the product's own SKU", async () => {
      const seeded = InMemoryProductRepository.buildProduct({ sku: "SKU-SELF" });
      seedWith([seeded]);

      await expect(
        service.update(seeded.id, { sku: "SKU-SELF", name: "Renamed" }),
      ).resolves.toMatchObject({ name: "Renamed" });
    });

    it("rejects a SKU already taken by another product", async () => {
      const first = InMemoryProductRepository.buildProduct({ sku: "SKU-A" });
      const second = InMemoryProductRepository.buildProduct({ sku: "SKU-B" });
      seedWith([first, second]);

      await expect(service.update(second.id, { sku: "SKU-A" })).rejects.toThrowError(
        ConflictError,
      );
    });

    it("throws NotFoundError when the product does not exist", async () => {
      await expect(service.update("missing-id", { name: "x" })).rejects.toThrowError(
        NotFoundError,
      );
    });
  });

  describe("remove", () => {
    it("deletes an existing product", async () => {
      const seeded = InMemoryProductRepository.buildProduct();
      seedWith([seeded]);

      await service.remove(seeded.id);

      expect(repository.size).toBe(0);
    });

    it("throws NotFoundError instead of silently succeeding", async () => {
      await expect(service.remove("missing-id")).rejects.toThrowError(NotFoundError);
    });
  });

  describe("list", () => {
    it("paginates and reports the unpaginated total", async () => {
      const seed = Array.from({ length: 5 }, (_, index) =>
        InMemoryProductRepository.buildProduct({
          sku: `SKU-${index}`,
          createdAt: new Date(2026, 0, index + 1),
        }),
      );
      seedWith(seed);

      const result = await service.list({ ...defaultQuery, limit: 2, page: 2 });

      expect(result.total).toBe(5);
      expect(result.items).toHaveLength(2);
    });

    it("filters by status", async () => {
      seedWith([
        InMemoryProductRepository.buildProduct({ sku: "A", status: "ACTIVE" }),
        InMemoryProductRepository.buildProduct({ sku: "B", status: "ARCHIVED" }),
      ]);

      const result = await service.list({ ...defaultQuery, status: "ARCHIVED" });

      expect(result.total).toBe(1);
      expect(result.items[0]?.sku).toBe("B");
    });
  });
  describe("inventory provisioning", () => {
    it("provisions an inventory record keyed by the new product id", async () => {
      const product = await service.create({
        sku: "SKU-200",
        name: "Desk",
        priceCents: 9999,
        currency: "USD",
        status: "ACTIVE",
        stock: { quantity: 25, reorderLevel: 5, warehouse: "north" },
      });

      const item = await inventory.findByProductId(product.id);
      expect(item).toMatchObject({
        sku: "SKU-200",
        productId: product.id,
        quantity: 25,
        reorderLevel: 5,
        warehouse: "north",
      });
      expect(product.stock).toMatchObject({ inventoryId: item?.id, available: 25 });
      expect(product.stockStatus).toBe("IN_STOCK");
    });

    it("falls back to inventory's own defaults when no opening stock is given", async () => {
      const product = await service.create({
        sku: "SKU-201",
        name: "Lamp",
        priceCents: 2500,
        currency: "USD",
        status: "DRAFT",
      });

      expect(await inventory.findByProductId(product.id)).toMatchObject({
        quantity: 0,
        warehouse: "default",
      });
      expect(product.stockStatus).toBe("OUT_OF_STOCK");
    });

    it("deletes the inventory record when the product insert fails", async () => {
      repository.create = () => Promise.reject(new Error("write conflict"));

      await expect(
        service.create({
          sku: "SKU-202",
          name: "Chair",
          priceCents: 4999,
          currency: "USD",
          status: "ACTIVE",
        }),
      ).rejects.toThrowError("write conflict");

      // Compensated: no orphan left behind in the other service.
      expect(inventory.size).toBe(0);
    });

    it("rolls the product back when provisioning fails", async () => {
      inventory.fail("create");

      await expect(
        service.create({
          sku: "SKU-203",
          name: "Monitor",
          priceCents: 19999,
          currency: "USD",
          status: "ACTIVE",
        }),
      ).rejects.toMatchObject({ statusCode: 503 });

      expect(repository.size).toBe(0);
    });

    it("reclaims the inventory record when provisioning fails ambiguously", async () => {
      // A timeout: the record was written, but the answer never came back.
      // The old rollback deleted only the product and stranded this row —
      // whose SKU then blocked every retry of the same product.
      inventory.failAfter("create");

      await expect(
        service.create({
          sku: "SKU-205",
          name: "Keyboard",
          priceCents: 7999,
          currency: "USD",
          status: "ACTIVE",
        }),
      ).rejects.toMatchObject({ statusCode: 503 });

      expect(repository.size).toBe(0);
      expect(inventory.size).toBe(0);
    });

    it("still rolls the product back when the inventory cleanup also fails", async () => {
      inventory.failAfter("create");
      inventory.fail("delete");

      await expect(
        service.create({
          sku: "SKU-206",
          name: "Mouse",
          priceCents: 2999,
          currency: "USD",
          status: "ACTIVE",
        }),
      ).rejects.toMatchObject({ statusCode: 503 });

      // The undo is best-effort, so the orphan survives — but the product
      // must not, or a failed create would look like a successful one.
      expect(repository.size).toBe(0);
      expect(inventory.size).toBe(1);
    });

    it("forwards the correlation id and actor downstream", async () => {
      await service.create(
        {
          sku: "SKU-204",
          name: "Cable",
          priceCents: 999,
          currency: "USD",
          status: "ACTIVE",
        },
        { requestId: "req-1", actor: "ops@example.com" },
      );

      expect(inventory.calls[0]).toMatchObject({
        method: "create",
        context: { requestId: "req-1", actor: "ops@example.com" },
      });
    });
  });

  describe("stock enrichment", () => {
    it("reports IN_STOCK, LOW_STOCK and OUT_OF_STOCK from the levels", async () => {
      const healthy = linkedPair({ sku: "OK" }, { quantity: 100, reserved: 0, reorderLevel: 10 });
      const low = linkedPair({ sku: "LOW" }, { quantity: 12, reserved: 5, reorderLevel: 10 });
      const empty = linkedPair({ sku: "OUT" }, { quantity: 5, reserved: 5, reorderLevel: 10 });
      seedWith(
        [healthy.product, low.product, empty.product],
        [healthy.item, low.item, empty.item],
      );

      const byId = async (id: string) => (await service.getById(id)).stockStatus;

      expect(await byId(healthy.product.id)).toBe("IN_STOCK");
      expect(await byId(low.product.id)).toBe("LOW_STOCK");
      expect(await byId(empty.product.id)).toBe("OUT_OF_STOCK");
    });

    it("reports UNPROVISIONED when inventory answers but has no record", async () => {
      const { product } = linkedPair();
      seedWith([product], []);

      const view = await service.getById(product.id);

      expect(view.stock).toBeNull();
      // Distinct from UNKNOWN: inventory replied, it simply has nothing yet,
      // which is the repairable residue of a half-finished create.
      expect(view.stockStatus).toBe("UNPROVISIONED");
    });

    it("reports UNPROVISIONED per row in a listing, not for the whole page", async () => {
      const provisioned = linkedPair({ sku: "HAS-STOCK" });
      const { product: bare } = linkedPair({ sku: "NO-STOCK" });
      seedWith([provisioned.product, bare], [provisioned.item]);

      const result = await service.list(defaultQuery);
      const bySku = new Map(result.items.map((item) => [item.sku, item.stockStatus]));

      expect(bySku.get("HAS-STOCK")).toBe("IN_STOCK");
      expect(bySku.get("NO-STOCK")).toBe("UNPROVISIONED");
    });

    it("still serves the product when inventory is down, as UNKNOWN", async () => {
      const { product, item } = linkedPair();
      seedWith([product], [item]);
      inventory.fail("findByProductId");

      const view = await service.getById(product.id);

      expect(view.id).toBe(product.id);
      expect(view.stock).toBeNull();
      expect(view.stockStatus).toBe("UNKNOWN");
    });

    it("enriches a whole page with one bulk call", async () => {
      const pairs = Array.from({ length: 3 }, (_, index) =>
        linkedPair({ sku: `SKU-${index}` }, { quantity: 10 * (index + 1) }),
      );
      seedWith(
        pairs.map((pair) => pair.product),
        pairs.map((pair) => pair.item),
      );

      const result = await service.list(defaultQuery);

      expect(result.items).toHaveLength(3);
      expect(result.items.every((item) => item.stock !== null)).toBe(true);
      expect(inventory.calls.filter((call) => call.method === "findByProductIds")).toHaveLength(1);
      expect(inventory.calls.filter((call) => call.method === "findById")).toHaveLength(0);
    });

    it("degrades the whole page to UNKNOWN when the bulk call fails", async () => {
      const { product, item } = linkedPair();
      seedWith([product], [item]);
      inventory.fail("findByProductIds");

      const result = await service.list(defaultQuery);

      expect(result.total).toBe(1);
      expect(result.items[0]?.stockStatus).toBe("UNKNOWN");
    });

    it("skips inventory entirely for an empty page", async () => {
      await service.list(defaultQuery);

      expect(inventory.calls).toHaveLength(0);
    });
  });

  describe("SKU synchronisation", () => {
    it("renames the inventory record alongside the product", async () => {
      const { product, item } = linkedPair({ sku: "SKU-OLD" });
      seedWith([product], [item]);

      const updated = await service.update(product.id, { sku: "SKU-NEW" });

      expect(updated.sku).toBe("SKU-NEW");
      expect(inventory.find(item.id)?.sku).toBe("SKU-NEW");
    });

    it("leaves inventory alone when the SKU is unchanged", async () => {
      const { product, item } = linkedPair({ sku: "SKU-SAME" });
      seedWith([product], [item]);

      await service.update(product.id, { sku: "SKU-SAME", name: "Renamed" });

      expect(inventory.calls.filter((call) => call.method === "update")).toHaveLength(0);
    });

    it("restores the inventory SKU when the product update fails", async () => {
      const { product, item } = linkedPair({ sku: "SKU-OLD" });
      seedWith([product], [item]);
      repository.update = () => Promise.reject(new Error("write conflict"));

      await expect(service.update(product.id, { sku: "SKU-NEW" })).rejects.toThrowError(
        "write conflict",
      );

      expect(inventory.find(item.id)?.sku).toBe("SKU-OLD");
    });
  });

  describe("deletion", () => {
    it("refuses to delete a product that still has stock on hand", async () => {
      const { product, item } = linkedPair({}, { quantity: 40, reserved: 0 });
      seedWith([product], [item]);

      await expect(service.remove(product.id)).rejects.toThrowError(ConflictError);
      expect(repository.size).toBe(1);
      expect(inventory.size).toBe(1);
    });

    it("refuses while units are reserved against open orders", async () => {
      const { product, item } = linkedPair({}, { quantity: 0, reserved: 0 });
      seedWith([product], [FakeInventoryClient.buildItem({ ...item, quantity: 3, reserved: 3 })]);

      await expect(service.remove(product.id)).rejects.toThrowError(ConflictError);
    });

    it("deletes both records once the stock is empty", async () => {
      const { product, item } = linkedPair({}, { quantity: 0, reserved: 0 });
      seedWith([product], [item]);

      await service.remove(product.id);

      expect(repository.size).toBe(0);
      expect(inventory.size).toBe(0);
    });

    it("still deletes the product when the inventory record is already gone", async () => {
      const { product } = linkedPair();
      seedWith([product], []);

      await service.remove(product.id);

      expect(repository.size).toBe(0);
    });

    it("keeps the product deleted even if the inventory cleanup fails", async () => {
      const { product, item } = linkedPair({}, { quantity: 0, reserved: 0 });
      seedWith([product], [item]);
      inventory.fail("delete");

      await service.remove(product.id);

      // The orphan is logged for reconciliation rather than failing the call.
      expect(repository.size).toBe(0);
      expect(inventory.size).toBe(1);
    });
  });
});
