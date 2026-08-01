import { randomUUID } from "node:crypto";
import type {
  ListProductsResult,
  Product,
  ProductRepository,
} from "../../src/modules/product/product.repository.js";
import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
} from "../../src/modules/product/product.schema.js";

/**
 * Test double for `ProductRepository`. Because the service layer depends on
 * the interface rather than Prisma, the whole HTTP stack can be exercised
 * with no database.
 */
export class InMemoryProductRepository implements ProductRepository {
  private readonly products = new Map<string, Product>();

  constructor(seed: Product[] = []) {
    for (const product of seed) this.products.set(product.id, product);
  }

  static buildProduct(overrides: Partial<Product> = {}): Product {
    const now = new Date("2026-01-01T00:00:00.000Z");
    return {
      id: randomUUID(),
      sku: "SKU-001",
      name: "Test Product",
      description: null,
      priceCents: 1999,
      currency: "USD",
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  async list(query: ListProductsQuery): Promise<ListProductsResult> {
    let items = [...this.products.values()];

    if (query.status) items = items.filter((item) => item.status === query.status);
    if (query.search) {
      const needle = query.search.toLowerCase();
      items = items.filter(
        (item) =>
          item.name.toLowerCase().includes(needle) || item.sku.toLowerCase().includes(needle),
      );
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

  async findById(id: string): Promise<Product | null> {
    return this.products.get(id) ?? null;
  }

  async findBySku(sku: string): Promise<Product | null> {
    return [...this.products.values()].find((item) => item.sku === sku) ?? null;
  }

  async create(input: CreateProductInput): Promise<Product> {
    const product = InMemoryProductRepository.buildProduct({
      ...input,
      description: input.description ?? null,
      id: randomUUID(),
    });
    this.products.set(product.id, product);
    return product;
  }

  async update(id: string, input: UpdateProductInput): Promise<Product> {
    const current = this.products.get(id);
    if (!current) throw new Error(`Product ${id} not found in test repository`);

    const updated: Product = {
      ...current,
      ...input,
      description: input.description ?? current.description,
      updatedAt: new Date(),
    };
    this.products.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    this.products.delete(id);
  }

  get size(): number {
    return this.products.size;
  }
}
