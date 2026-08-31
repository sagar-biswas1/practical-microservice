import { env } from "../config/env.js";
import { API_PREFIX } from "../routes/index.js";
import {
  createProductSchema,
  listProductsQuerySchema,
  productIdParamsSchema,
  updateProductSchema,
  PRODUCT_STATUSES,
} from "../modules/product/product.schema.js";
import { STOCK_STATUSES } from "../modules/product/product.service.js";
import {
  bearerAuthScheme,
  commonSchemas,
  errorResponses,
  healthPaths,
  jsonBody,
  noContentResponse,
  paginatedResponse,
  parametersFrom,
  rootPath,
  successResponse,
  type JsonSchema,
  type OpenApiDocument,
} from "./openapi-helpers.js";

const productIdParameters = parametersFrom(productIdParamsSchema, "path");

const productStock: JsonSchema = {
  type: "object",
  description:
    "The slice of the inventory record this service republishes. `null` when inventory holds no record for the product, or could not be reached — `stockStatus` tells the two apart.",
  required: ["inventoryId", "sku", "warehouse", "quantity", "reserved", "available", "reorderLevel"],
  properties: {
    inventoryId: { type: "string", format: "uuid" },
    sku: { type: "string" },
    warehouse: { type: "string" },
    quantity: { type: "integer", description: "Units physically on hand, reserved units included." },
    reserved: { type: "integer", description: "Units promised to open orders." },
    available: { type: "integer", description: "`quantity - reserved`." },
    reorderLevel: { type: "integer" },
  },
};

const product: JsonSchema = {
  type: "object",
  description: "A catalogue entry, enriched with the stock figures owned by the inventory service.",
  required: [
    "id",
    "sku",
    "name",
    "priceCents",
    "currency",
    "status",
    "createdAt",
    "updatedAt",
    "stock",
    "stockStatus",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    sku: { type: "string", maxLength: 64, description: "Stored upper-cased." },
    name: { type: "string", maxLength: 200 },
    description: { type: ["string", "null"], maxLength: 5000 },
    priceCents: {
      type: "integer",
      description: "Minor units. Integers only — a price is never a float here.",
    },
    currency: { type: "string", minLength: 3, maxLength: 3, description: "ISO 4217, upper-cased." },
    status: { type: "string", enum: [...PRODUCT_STATUSES] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    stock: { oneOf: [productStock, { type: "null" }] },
    stockStatus: {
      type: "string",
      enum: [...STOCK_STATUSES],
      description:
        "Derived. `UNPROVISIONED` means inventory answered and has no record; `UNKNOWN` means inventory could not be reached. Neither is the same as `OUT_OF_STOCK`, and collapsing them would stop you selling goods you actually hold.",
    },
  },
};

const createExample = {
  sku: "WIDGET-001",
  name: "Widget",
  description: "A widget.",
  priceCents: 1999,
  currency: "USD",
  status: "ACTIVE",
  stock: { warehouse: "default", quantity: 25, reorderLevel: 5 },
};

export const openapiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Product service",
    version: "1.0.0",
    description: [
      "The product catalogue. Reads are enriched with stock levels fetched from the inventory service, and writes provision and maintain the matching inventory record.",
      "",
      "**Where authentication is enforced.** This service does not verify tokens. The api-gateway does, in front of it — catalogue reads are public, and every write requires an `ADMIN` token (see `config/route-policies.ts` in the gateway). Operations marked with a padlock below are the ones the edge protects; calling them directly on this service's own port bypasses that check, which is why the port belongs on a private network.",
      "",
      "**Stock is not patchable here.** Levels move through the inventory service's own `receive` / `sell` / `adjust` endpoints, each of which writes a ledger entry. A `sku` change *is* mirrored onto the inventory record so the two never drift apart.",
    ].join("\n"),
  },
  servers: [
    { url: "http://localhost:4000", description: "Through the api-gateway (token verified at the edge)" },
    { url: `http://localhost:${env.PORT}`, description: "Direct — development only" },
  ],
  tags: [
    { name: "Products", description: "The catalogue." },
    { name: "Health", description: "Liveness and readiness probes." },
    { name: "Meta", description: "Service banner." },
  ],
  components: {
    securitySchemes: { bearerAuth: bearerAuthScheme },
    schemas: { ...commonSchemas, Product: product, ProductStock: productStock },
  },
  paths: {
    "/": rootPath(env.SERVICE_NAME),
    ...healthPaths(API_PREFIX, env.SERVICE_NAME),

    [`${API_PREFIX}/products`]: {
      get: {
        tags: ["Products"],
        operationId: "listProducts",
        summary: "List products",
        security: [],
        description:
          "Paginated, filterable catalogue listing. Stock for the whole page is fetched from the inventory service in one bulk call, not one per product; if that call fails the products are still returned, with `stockStatus: UNKNOWN`.",
        parameters: parametersFrom(listProductsQuerySchema, "query"),
        responses: {
          "200": paginatedResponse("A page of products.", { $ref: "#/components/schemas/Product" }),
          ...errorResponses("422", "429", "500", "503"),
        },
      },
      post: {
        tags: ["Products"],
        operationId: "createProduct",
        summary: "Create a product",
        description:
          "Writes the product, then provisions its inventory record keyed by the new product id. If provisioning fails the product is deleted again, so a caller never sees a listing with no stock behind it.\n\n`inventoryId` is deliberately not accepted: this service owns that link, and a client-supplied id could point at another product's stock.",
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody(createProductSchema, { example: createExample }),
        responses: {
          "201": successResponse("Created, with its inventory record provisioned.", {
            $ref: "#/components/schemas/Product",
          }),
          ...errorResponses("400", "401", "403", "409", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/products/{id}`]: {
      parameters: productIdParameters,
      get: {
        tags: ["Products"],
        operationId: "getProduct",
        summary: "Fetch one product",
        security: [],
        responses: {
          "200": successResponse("The product.", { $ref: "#/components/schemas/Product" }),
          ...errorResponses("404", "422", "429", "500", "503"),
        },
      },
      patch: {
        tags: ["Products"],
        operationId: "updateProduct",
        summary: "Update a product",
        description:
          "At least one field must be present — an empty body is rejected rather than treated as a successful no-op.\n\nA `sku` change reaches the inventory record first: it is the side that can reject the new SKU as a duplicate, and finding that out before the product row moves keeps the failure clean.",
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody(updateProductSchema, {
          example: { priceCents: 2499, status: "ACTIVE" },
        }),
        responses: {
          "200": successResponse("The updated product.", { $ref: "#/components/schemas/Product" }),
          ...errorResponses("400", "401", "403", "404", "409", "413", "422", "429", "500", "503"),
        },
      },
      delete: {
        tags: ["Products"],
        operationId: "deleteProduct",
        summary: "Delete a product",
        description:
          "Refused with a 409 while the product still holds stock or reservations: the inventory record carries the movement ledger and audit trail, and dropping it would destroy history that outlives the listing. Archive the product (`status: ARCHIVED`) to retire it non-destructively.",
        security: [{ bearerAuth: [] }],
        responses: {
          "204": noContentResponse,
          ...errorResponses("401", "403", "404", "409", "422", "429", "500", "503"),
        },
      },
    },
  },
};
