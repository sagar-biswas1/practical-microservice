import { z } from "zod";

export const PRODUCT_STATUSES = ["DRAFT", "ACTIVE", "ARCHIVED"] as const;
export type ProductStatusValue = (typeof PRODUCT_STATUSES)[number];

export const PRODUCT_SORT_FIELDS = ["createdAt", "name", "priceCents"] as const;

export const productIdParamsSchema = z.object({
  id: z.uuid("Product id must be a valid UUID"),
});

/**
 * Field definitions without defaults.
 *
 * Defaults live only on the create schema: `.partial()` does NOT strip them,
 * so a base carrying `.default()` would make an empty PATCH body parse into
 * `{ currency, status }` and quietly reset those columns.
 */
const productFieldsSchema = z.strictObject({
  sku: z
    .string()
    .trim()
    .min(3, "SKU must be at least 3 characters")
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, "SKU may only contain letters, digits, '.', '_' and '-'")
    .transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z.string().trim().max(5000).optional(),
  priceCents: z
    .number()
    .int("Price must be an integer number of cents")
    .nonnegative("Price cannot be negative")
    .max(100_000_000),
  currency: z
    .string()
    .trim()
    .length(3, "Currency must be a 3-letter ISO 4217 code")
    .transform((value) => value.toUpperCase()),
  status: z.enum(PRODUCT_STATUSES),
});

export const createProductSchema = productFieldsSchema.extend({
  currency: productFieldsSchema.shape.currency.default("USD"),
  status: productFieldsSchema.shape.status.default("DRAFT"),
});

// Every field optional, but reject a no-op patch so an empty body can't
// masquerade as a successful update.
export const updateProductSchema = productFieldsSchema
  .partial()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "At least one field must be provided",
  });

export const listProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(PRODUCT_STATUSES).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  sortBy: z.enum(PRODUCT_SORT_FIELDS).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
export type ProductIdParams = z.infer<typeof productIdParamsSchema>;
