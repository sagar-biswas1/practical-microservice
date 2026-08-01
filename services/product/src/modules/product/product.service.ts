import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import type { ListProductsResult, Product, ProductRepository } from "./product.repository.js";
import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
} from "./product.schema.js";

/**
 * Business rules for products. Deliberately free of Express and Prisma types
 * so it can be unit-tested directly and reused from a queue consumer or CLI.
 */
export class ProductService {
  constructor(private readonly repository: ProductRepository) {}

  list(query: ListProductsQuery): Promise<ListProductsResult> {
    return this.repository.list(query);
  }

  async getById(id: string): Promise<Product> {
    const product = await this.repository.findById(id);
    if (!product) throw new NotFoundError(`Product '${id}' was not found`);
    return product;
  }

  async create(input: CreateProductInput): Promise<Product> {
    const existing = await this.repository.findBySku(input.sku);
    if (existing) throw new ConflictError(`A product with SKU '${input.sku}' already exists`);
    return this.repository.create(input);
  }

  async update(id: string, input: UpdateProductInput): Promise<Product> {
    const current = await this.getById(id);

    if (input.sku && input.sku !== current.sku) {
      const conflicting = await this.repository.findBySku(input.sku);
      if (conflicting && conflicting.id !== id) {
        throw new ConflictError(`A product with SKU '${input.sku}' already exists`);
      }
    }

    return this.repository.update(id, input);
  }

  async remove(id: string): Promise<void> {
    await this.getById(id);
    await this.repository.delete(id);
  }
}
