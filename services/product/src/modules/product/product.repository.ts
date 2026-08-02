import type { Prisma, Product } from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../lib/prisma.js";
import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
} from "./product.schema.js";

export type { Product };

export interface ListProductsResult {
  items: Product[];
  total: number;
}

/**
 * The row as written to the database. Opening stock is stripped out — it
 * belongs to the inventory service — and the id is left to the database,
 * because nothing has to reference the product before it exists.
 */
export type NewProductRecord = Omit<CreateProductInput, "stock">;

/**
 * Persistence boundary for products. The service layer depends on this
 * interface, not on Prisma — which is what lets the tests swap in an
 * in-memory implementation and keeps the storage engine replaceable.
 */
export interface ProductRepository {
  list(query: ListProductsQuery): Promise<ListProductsResult>;
  findById(id: string): Promise<Product | null>;
  findBySku(sku: string): Promise<Product | null>;
  create(input: NewProductRecord): Promise<Product>;
  update(id: string, input: UpdateProductInput): Promise<Product>;
  delete(id: string): Promise<void>;
}

export class PrismaProductRepository implements ProductRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: ListProductsQuery): Promise<ListProductsResult> {
    const where: Prisma.ProductWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: "insensitive" } },
              { sku: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: { [query.sortBy]: query.order },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total };
  }

  findById(id: string): Promise<Product | null> {
    return this.prisma.product.findUnique({ where: { id } });
  }

  findBySku(sku: string): Promise<Product | null> {
    return this.prisma.product.findUnique({ where: { sku } });
  }

  create(input: NewProductRecord): Promise<Product> {
    return this.prisma.product.create({ data: input });
  }

  update(id: string, input: UpdateProductInput): Promise<Product> {
    return this.prisma.product.update({ where: { id }, data: input });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.product.delete({ where: { id } });
  }
}
