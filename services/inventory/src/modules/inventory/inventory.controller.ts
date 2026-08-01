import type { Request, Response } from "express";
import { validated } from "../../middlewares/validate.js";
import { sendCreated, sendNoContent, sendPaginated, sendSuccess } from "../../utils/api-response.js";
import type { InventoryService } from "./inventory.service.js";
import type {
  AdjustStockInput,
  CreateInventoryItemInput,
  FulfilStockInput,
  InventoryIdParams,
  ListAuditLogsQuery,
  ListInventoryQuery,
  ListMovementsQuery,
  ReceiveStockInput,
  ReleaseStockInput,
  ReserveStockInput,
  ReturnStockInput,
  SellStockInput,
  SkuParams,
  UpdateInventoryItemInput,
} from "./inventory.schema.js";

export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { query } = validated<unknown, ListInventoryQuery>(req);
    const { items, total } = await this.service.list(query);
    sendPaginated(res, items, { page: query.page, limit: query.limit, total });
  };

  getById = async (req: Request, res: Response): Promise<void> => {
    const { params } = validated<unknown, unknown, InventoryIdParams>(req);
    sendSuccess(res, await this.service.getById(params.id));
  };

  getBySku = async (req: Request, res: Response): Promise<void> => {
    const { params } = validated<unknown, unknown, SkuParams>(req);
    sendSuccess(res, await this.service.getBySku(params.sku));
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const { body } = validated<CreateInventoryItemInput>(req);
    const item = await this.service.create(body);
    req.log.info({ itemId: item.id, sku: item.sku }, "inventory_item_created");
    sendCreated(res, item);
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const { body, params } = validated<UpdateInventoryItemInput, unknown, InventoryIdParams>(req);
    const item = await this.service.update(params.id, body, req.actor);
    req.log.info(
      { itemId: item.id, fields: Object.keys(body), actor: req.actor ?? null },
      "inventory_item_updated",
    );
    sendSuccess(res, item);
  };

  listAuditLogs = async (req: Request, res: Response): Promise<void> => {
    const { params, query } = validated<unknown, ListAuditLogsQuery, InventoryIdParams>(req);
    const { items, total } = await this.service.listAuditLogs(params.id, query);
    sendPaginated(res, items, { page: query.page, limit: query.limit, total });
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const { params } = validated<unknown, unknown, InventoryIdParams>(req);
    await this.service.remove(params.id);
    req.log.info({ itemId: params.id }, "inventory_item_deleted");
    sendNoContent(res);
  };

  listMovements = async (req: Request, res: Response): Promise<void> => {
    const { params, query } = validated<unknown, ListMovementsQuery, InventoryIdParams>(req);
    const { items, total } = await this.service.listMovements(params.id, query);
    sendPaginated(res, items, { page: query.page, limit: query.limit, total });
  };

  reserve = async (req: Request, res: Response): Promise<void> => {
    const { body, params } = validated<ReserveStockInput, unknown, InventoryIdParams>(req);
    const item = await this.service.reserve(params.id, body);
    req.log.info(
      { itemId: item.id, quantity: body.quantity, available: item.available },
      "stock_reserved",
    );
    sendSuccess(res, item);
  };

  release = async (req: Request, res: Response): Promise<void> => {
    const { body, params } = validated<ReleaseStockInput, unknown, InventoryIdParams>(req);
    const item = await this.service.release(params.id, body);
    req.log.info({ itemId: item.id, quantity: body.quantity }, "stock_released");
    sendSuccess(res, item);
  };

  fulfil = async (req: Request, res: Response): Promise<void> => {
    const { body, params } = validated<FulfilStockInput, unknown, InventoryIdParams>(req);
    const item = await this.service.fulfil(params.id, body);
    req.log.info({ itemId: item.id, quantity: body.quantity }, "stock_fulfilled");
    sendSuccess(res, item);
  };

  sell = async (req: Request, res: Response): Promise<void> => {
    const { body, params } = validated<SellStockInput, unknown, InventoryIdParams>(req);
    const item = await this.service.sell(params.id, body);
    req.log.info(
      { itemId: item.id, quantity: body.quantity, reference: body.reference },
      "stock_sold",
    );
    sendSuccess(res, item);
  };

  acceptReturn = async (req: Request, res: Response): Promise<void> => {
    const { body, params } = validated<ReturnStockInput, unknown, InventoryIdParams>(req);
    const item = await this.service.acceptReturn(params.id, body);
    req.log.info(
      { itemId: item.id, quantity: body.quantity, reference: body.reference },
      "stock_returned",
    );
    sendSuccess(res, item);
  };

  receive = async (req: Request, res: Response): Promise<void> => {
    const { body, params } = validated<ReceiveStockInput, unknown, InventoryIdParams>(req);
    const item = await this.service.receive(params.id, body);
    req.log.info({ itemId: item.id, quantity: body.quantity }, "stock_received");
    sendSuccess(res, item);
  };

  adjust = async (req: Request, res: Response): Promise<void> => {
    const { body, params } = validated<AdjustStockInput, unknown, InventoryIdParams>(req);
    const item = await this.service.adjust(params.id, body);
    req.log.warn(
      { itemId: item.id, delta: body.delta, reason: body.reason },
      "stock_adjusted",
    );
    sendSuccess(res, item);
  };
}
