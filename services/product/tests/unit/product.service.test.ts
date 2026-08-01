import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../../src/errors/app-error.js";
import { ProductService } from "../../src/modules/product/product.service.js";
import type { ListProductsQuery } from "../../src/modules/product/product.schema.js";
import { InMemoryProductRepository } from "../helpers/in-memory-product-repository.js";

const defaultQuery: ListProductsQuery = {
  page: 1,
  limit: 20,
  sortBy: "createdAt",
  order: "desc",
};

describe("ProductService", () => {
  let repository: InMemoryProductRepository;
  let service: ProductService;

  beforeEach(() => {
    repository = new InMemoryProductRepository();
    service = new ProductService(repository);
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
      repository = new InMemoryProductRepository([seeded]);
      service = new ProductService(repository);

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
      repository = new InMemoryProductRepository([seeded]);
      service = new ProductService(repository);

      const updated = await service.update(seeded.id, { name: "New" });

      expect(updated.name).toBe("New");
      expect(updated.sku).toBe(seeded.sku);
    });

    it("allows re-submitting the product's own SKU", async () => {
      const seeded = InMemoryProductRepository.buildProduct({ sku: "SKU-SELF" });
      repository = new InMemoryProductRepository([seeded]);
      service = new ProductService(repository);

      await expect(
        service.update(seeded.id, { sku: "SKU-SELF", name: "Renamed" }),
      ).resolves.toMatchObject({ name: "Renamed" });
    });

    it("rejects a SKU already taken by another product", async () => {
      const first = InMemoryProductRepository.buildProduct({ sku: "SKU-A" });
      const second = InMemoryProductRepository.buildProduct({ sku: "SKU-B" });
      repository = new InMemoryProductRepository([first, second]);
      service = new ProductService(repository);

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
      repository = new InMemoryProductRepository([seeded]);
      service = new ProductService(repository);

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
      repository = new InMemoryProductRepository(seed);
      service = new ProductService(repository);

      const result = await service.list({ ...defaultQuery, limit: 2, page: 2 });

      expect(result.total).toBe(5);
      expect(result.items).toHaveLength(2);
    });

    it("filters by status", async () => {
      repository = new InMemoryProductRepository([
        InMemoryProductRepository.buildProduct({ sku: "A", status: "ACTIVE" }),
        InMemoryProductRepository.buildProduct({ sku: "B", status: "ARCHIVED" }),
      ]);
      service = new ProductService(repository);

      const result = await service.list({ ...defaultQuery, status: "ARCHIVED" });

      expect(result.total).toBe(1);
      expect(result.items[0]?.sku).toBe("B");
    });
  });
});
