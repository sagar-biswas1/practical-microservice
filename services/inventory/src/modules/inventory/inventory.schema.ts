import { z } from "zod";
import { StockMovementType } from "../../generated/prisma/enums.js";

// Sourced from the generated enum rather than re-typed: renaming a member in
// schema.prisma then becomes a compile error here instead of a 400 at runtime.
export const STOCK_MOVEMENT_TYPES = StockMovementType;
export type StockMovementTypeValue = StockMovementType;

export const INVENTORY_SORT_FIELDS = ["createdAt", "sku", "quantity"] as const;

const skuField = z
  .string()
  .trim()
  .min(3, "SKU must be at least 3 characters")
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "SKU may only contain letters, digits, '.', '_' and '-'")
  .transform((value) => value.toUpperCase());

export const inventoryIdParamsSchema = z.object({
  id: z.uuid("Inventory item id must be a valid UUID"),
});

export const skuParamsSchema = z.object({
  sku: skuField,
});

// No defaults here — `.partial()` preserves them, which would turn an empty
// PATCH body into a silent overwrite. Defaults belong on the create schema.
const inventoryFieldsSchema = z.strictObject({
  sku: skuField,
  productId: z.uuid("productId must be a valid UUID"),
  warehouse: z.string().trim().min(1).max(64),
  quantity: z.number().int("Quantity must be a whole number").nonnegative().max(1_000_000_000),
  reorderLevel: z.number().int().nonnegative().max(1_000_000_000),
});

/**
 * Columns the audit trail covers — by construction, exactly the patchable
 * set, so a field added above cannot be silently left untracked.
 */
export const AUDITED_FIELDS = Object.keys(inventoryFieldsSchema.shape) as [
  InventoryFieldName,
  ...InventoryFieldName[],
];
export type InventoryFieldName = keyof typeof inventoryFieldsSchema.shape;

export const createInventoryItemSchema = inventoryFieldsSchema.extend({
  warehouse: inventoryFieldsSchema.shape.warehouse.default("default"),
  quantity: inventoryFieldsSchema.shape.quantity.default(0),
  reorderLevel: inventoryFieldsSchema.shape.reorderLevel.default(0),
});

/**
 * Every column is patchable. Each accepted field is diffed against the stored
 * row and written to the audit log, and a `quantity` edit additionally lands
 * in the stock ledger as an ADJUSTMENT.
 *
 * `reserved` is deliberately absent: those units are promises made to open
 * orders, and the reservation endpoints are the only thing allowed to move
 * that counter. Editing it by hand would silently break outstanding orders.
 */
export const updateInventoryItemSchema = inventoryFieldsSchema
  .partial()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "At least one field must be provided",
  });

const positiveQuantity = z
  .number()
  .int("Quantity must be a whole number")
  .positive("Quantity must be greater than zero")
  .max(1_000_000_000);

const reason = z.string().trim().min(1).max(500).optional();
const reference = z.string().trim().min(1).max(120).optional();

export const reserveStockSchema = z.strictObject({
  quantity: positiveQuantity,
  reason,
  reference,
});

export const releaseStockSchema = reserveStockSchema;

export const fulfilStockSchema = reserveStockSchema;

export const receiveStockSchema = reserveStockSchema;

/**
 * Sales and returns cross a service boundary, so the order reference is
 * mandatory: without it the ledger cannot be reconciled against the order
 * service, and a duplicated sale event is impossible to spot after the fact.
 */
export const sellStockSchema = z.strictObject({
  quantity: positiveQuantity,
  reason,
  reference: z
    .string()
    .trim()
    .min(1, "A sale must reference its order")
    .max(120),
});

export const returnStockSchema = sellStockSchema;

/** A signed correction; negative values reduce on-hand stock. */
export const adjustStockSchema = z.strictObject({
  delta: z
    .number()
    .int("Delta must be a whole number")
    .refine((value) => value !== 0, "Delta must not be zero")
    .min(-1_000_000_000)
    .max(1_000_000_000),
  reason: z.string().trim().min(1, "An adjustment must state a reason").max(500),
  reference,
});

export const listInventoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sku: z.string().trim().min(1).max(64).optional(),
  productId: z.uuid().optional(),
  warehouse: z.string().trim().min(1).max(64).optional(),
  /** Only items at or below their reorder level. */
  lowStock: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  sortBy: z.enum(INVENTORY_SORT_FIELDS).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Narrow the trail to a single column, e.g. `?field=reorderLevel`. */
  field: z.enum(AUDITED_FIELDS).optional(),
  actor: z.string().trim().min(1).max(120).optional(),
});

export const listMovementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum(STOCK_MOVEMENT_TYPES).optional(),
});

export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;
export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;
export type ReserveStockInput = z.infer<typeof reserveStockSchema>;
export type ReleaseStockInput = z.infer<typeof releaseStockSchema>;
export type FulfilStockInput = z.infer<typeof fulfilStockSchema>;
export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;
export type SellStockInput = z.infer<typeof sellStockSchema>;
export type ReturnStockInput = z.infer<typeof returnStockSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type ListInventoryQuery = z.infer<typeof listInventoryQuerySchema>;
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;
export type InventoryIdParams = z.infer<typeof inventoryIdParamsSchema>;
export type SkuParams = z.infer<typeof skuParamsSchema>;
