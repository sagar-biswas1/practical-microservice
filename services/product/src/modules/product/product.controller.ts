import type { Request, Response } from "express";
import { validated } from "../../middlewares/validate.js";
import { sendCreated, sendNoContent, sendPaginated, sendSuccess } from "../../utils/api-response.js";
import type { ProductService } from "./product.service.js";
import type {
  CreateProductInput,
  ListProductsQuery,
  ProductIdParams,
  UpdateProductInput,
} from "./product.schema.js";

/**
 * HTTP adapter: reads validated input, delegates to the service, shapes the
 * response. No business logic, no try/catch — thrown errors travel to the
 * global error handler.
 */
export class ProductController {
  constructor(private readonly service: ProductService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { query } = validated<unknown, ListProductsQuery>(req);
    const { items, total } = await this.service.list(query);
    sendPaginated(res, items, { page: query.page, limit: query.limit, total });
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    const { params } = validated<unknown, unknown, ProductIdParams>(req);
    const product = await this.service.getById(params.id);
    sendSuccess(res, product);
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const { body } = validated<CreateProductInput>(req);
    const product = await this.service.create(body);
    req.log.info({ productId: product.id, sku: product.sku }, "product_created");
    sendCreated(res, product);
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { body, params } = validated<UpdateProductInput, unknown, ProductIdParams>(req);
    const product = await this.service.update(params.id, body);
    req.log.info({ productId: product.id }, "product_updated");
    sendSuccess(res, product);
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { params } = validated<unknown, unknown, ProductIdParams>(req);
    await this.service.remove(params.id);
    req.log.info({ productId: params.id }, "product_deleted");
    sendNoContent(res);
  };
}
