import type { ZodType } from "zod";
import { env } from "../config/env.js";
import { ACTOR_HEADER } from "../middlewares/request-context.js";
import { API_PREFIX } from "../routes/index.js";
import {
  adjustStockSchema,
  createInventoryItemSchema,
  inventoryIdParamsSchema,
  listAuditLogsQuerySchema,
  listInventoryQuerySchema,
  listMovementsQuerySchema,
  reserveStockSchema,
  sellStockSchema,
  skuParamsSchema,
  updateInventoryItemSchema,
  AUDITED_FIELDS,
  STOCK_MOVEMENT_TYPES,
} from "../modules/inventory/inventory.schema.js";
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

const idParameters = parametersFrom(inventoryIdParamsSchema, "path");

const actorHeaderParameter: JsonSchema = {
  name: ACTOR_HEADER,
  in: "header",
  required: false,
  description:
    "Who to attribute the change to in the audit trail. Set by the gateway from the verified token; an inbound value is discarded there unless `TRUST_CLIENT_ACTOR` is on. Absent means the row is written unattributed.",
  schema: { type: "string", maxLength: 120 },
};

const inventoryItem: JsonSchema = {
  type: "object",
  description: "One stock record. Exactly one per product, keyed by `productId`.",
  required: [
    "id",
    "sku",
    "productId",
    "warehouse",
    "quantity",
    "reserved",
    "reorderLevel",
    "available",
    "lowStock",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    sku: { type: "string", maxLength: 64, description: "Stored upper-cased." },
    productId: {
      type: "string",
      format: "uuid",
      description:
        "Soft reference to the product service. There is deliberately no foreign key across a service boundary.",
    },
    warehouse: { type: "string", maxLength: 64 },
    quantity: { type: "integer", description: "Units physically on hand, reserved units included." },
    reserved: {
      type: "integer",
      description:
        "Units promised to open orders. Not patchable — only the reservation endpoints move this counter.",
    },
    reorderLevel: { type: "integer" },
    available: { type: "integer", description: "Derived: `quantity - reserved`." },
    lowStock: { type: "boolean", description: "Derived: `available <= reorderLevel`." },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const auditLog: JsonSchema = {
  type: "object",
  description:
    "One field-level change made through PATCH. Separate from the stock ledger on purpose: this table answers \"who changed what, and from what to what\" for any column, including ones that move no stock.",
  required: ["id", "itemId", "field", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    itemId: { type: "string", format: "uuid" },
    field: { type: "string", enum: [...AUDITED_FIELDS] },
    oldValue: { type: ["string", "null"], description: "Rendered as text so one table can log any column type." },
    newValue: { type: ["string", "null"] },
    actor: { type: ["string", "null"], description: "Null when the change was unattributed." },
    createdAt: { type: "string", format: "date-time" },
  },
};

const movement: JsonSchema = {
  type: "object",
  description: "One entry in the stock ledger. Append-only: every row is a real movement.",
  required: ["id", "itemId", "type", "quantityChanged", "lastQuantity", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    itemId: { type: "string", format: "uuid" },
    type: { type: "string", enum: Object.values(STOCK_MOVEMENT_TYPES) },
    quantityChanged: {
      type: "integer",
      description: "Always positive. `type` carries the direction.",
    },
    lastQuantity: { type: "integer", description: "On-hand quantity before this movement." },
    reason: { type: ["string", "null"] },
    reference: {
      type: ["string", "null"],
      description: "Correlation handle for the originating order or shipment.",
    },
    createdAt: { type: "string", format: "date-time" },
  },
};

const itemResponses = {
  "200": successResponse("The item, with its derived stock figures.", {
    $ref: "#/components/schemas/InventoryItem",
  }),
};

/**
 * The six quantity-based transitions share one request shape and one set of
 * outcomes; only the ledger entry and the invariant differ. Declaring them
 * from a table keeps that symmetry visible instead of copy-pasting it seven
 * times.
 */
interface Transition {
  path: string;
  operationId: string;
  summary: string;
  description: string;
  schema: ZodType;
  example: Record<string, unknown>;
}

const transitions: Transition[] = [
  {
    path: "reserve",
    operationId: "reserveStock",
    summary: "Reserve stock",
    description:
      "Promises units to an open order without shipping them. Raises `reserved`, leaves `quantity` alone, lowers `available`. Refused with a 409 when `available` cannot cover the request.",
    schema: reserveStockSchema,
    example: { quantity: 2, reference: "order_1042" },
  },
  {
    path: "release",
    operationId: "releaseStock",
    summary: "Release a reservation",
    description: "Returns previously reserved units to the available pool. Refused with a 409 when it would drive `reserved` below zero.",
    schema: reserveStockSchema,
    example: { quantity: 2, reason: "Order cancelled", reference: "order_1042" },
  },
  {
    path: "fulfil",
    operationId: "fulfilStock",
    summary: "Ship reserved stock",
    description: "Drops both `quantity` and `reserved`: the goods that were being held have left. Recorded as `OUTBOUND`.",
    schema: reserveStockSchema,
    example: { quantity: 2, reference: "shipment_77" },
  },
  {
    path: "sell",
    operationId: "sellStock",
    summary: "Sell unreserved stock",
    description:
      "A walk-in or single-step checkout — goods leave without having been reserved first. Recorded as `OUTBOUND`, same as a fulfilment, because physically the same thing happened. Two-step order flows should still go reserve → fulfil so units are held while payment settles.\n\n`reference` is mandatory here: without it the ledger cannot be reconciled against the order service, and a duplicated sale is impossible to spot after the fact.",
    schema: sellStockSchema,
    example: { quantity: 1, reference: "order_1043" },
  },
  {
    path: "return",
    operationId: "returnStock",
    summary: "Accept a customer return",
    description:
      "Units come back on the shelf. The level change is identical to a delivery; only the ledger entry differs (`RETURN` rather than `INBOUND`), so returned goods can be separated from purchased ones in reporting.",
    schema: sellStockSchema,
    example: { quantity: 1, reference: "order_1043" },
  },
  {
    path: "receive",
    operationId: "receiveStock",
    summary: "Book in a delivery",
    description: "Raises `quantity`. Recorded as `INBOUND`.",
    schema: reserveStockSchema,
    example: { quantity: 50, reference: "po_9001" },
  },
];

const transitionPaths: Record<string, JsonSchema> = Object.fromEntries(
  transitions.map((transition) => [
    `${API_PREFIX}/inventory/{id}/${transition.path}`,
    {
      parameters: idParameters,
      post: {
        tags: ["Stock movements"],
        operationId: transition.operationId,
        summary: transition.summary,
        description: transition.description,
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody(transition.schema, { example: transition.example }),
        responses: {
          ...itemResponses,
          ...errorResponses("400", "401", "403", "404", "409", "413", "422", "429", "500", "503"),
        },
      },
    },
  ]),
);

export const openapiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Inventory service",
    version: "1.0.0",
    description: [
      "Stock levels and the audited history behind them. This service calls nobody; the product service calls it.",
      "",
      "**Stock transitions are POSTs on sub-resources, not PATCHes on a counter.** Each one is a discrete, audited event — reserve, release, fulfil, sell, return, receive, adjust — and each writes a row to the stock ledger. `PATCH /inventory/{id}` exists for the *columns*, and `reserved` is deliberately outside its reach: those units are promises made to open orders, and editing the number by hand would silently break them.",
      "",
      "**Two histories, not one.** `/movements` is the stock ledger, where every row is a real movement. `/audit-logs` is the field-level change trail for PATCH, which covers columns that move no stock at all.",
      "",
      "**Where authentication is enforced.** This service does not verify tokens; the api-gateway does. At the edge, every read here needs a token and every write needs `ADMIN` — stock levels are operational data, so even reads have a caller. The product service composes stock into its own public responses by calling this service directly, which is why the product endpoints stay open.",
    ].join("\n"),
  },
  servers: [
    { url: "http://localhost:4000", description: "Through the api-gateway (token verified at the edge)" },
    { url: `http://localhost:${env.PORT}`, description: "Direct — development only" },
  ],
  tags: [
    { name: "Inventory", description: "Stock records." },
    { name: "Stock movements", description: "The audited transitions that move stock." },
    { name: "History", description: "The stock ledger and the field-level change trail." },
    { name: "Health", description: "Liveness and readiness probes." },
    { name: "Meta", description: "Service banner." },
  ],
  components: {
    securitySchemes: { bearerAuth: bearerAuthScheme },
    schemas: {
      ...commonSchemas,
      InventoryItem: inventoryItem,
      InventoryAuditLog: auditLog,
      StockMovement: movement,
    },
  },
  paths: {
    "/": rootPath(env.SERVICE_NAME),
    ...healthPaths(API_PREFIX, env.SERVICE_NAME),

    [`${API_PREFIX}/inventory`]: {
      get: {
        tags: ["Inventory"],
        operationId: "listInventory",
        summary: "List stock records",
        description:
          "`productIds` takes a comma-separated list, which is how a caller enriches a whole page of products in one round trip instead of one request per item.\n\n`lowStock=true` filters to items at or below their reorder level. That comparison is between two columns, so it is applied after the page is read rather than in SQL — the counts it reports are for the filtered set.",
        security: [{ bearerAuth: [] }],
        parameters: parametersFrom(listInventoryQuerySchema, "query"),
        responses: {
          "200": paginatedResponse("A page of stock records.", {
            $ref: "#/components/schemas/InventoryItem",
          }),
          ...errorResponses("401", "422", "429", "500", "503"),
        },
      },
      post: {
        tags: ["Inventory"],
        operationId: "createInventoryItem",
        summary: "Create a stock record",
        description:
          "Normally called by the product service when a product is created, not by a client. Both `sku` and `productId` are unique, so a duplicated create is rejected by the database rather than quietly producing a second record for the same product — which is what makes provisioning safe to retry.",
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody(createInventoryItemSchema, {
          example: {
            sku: "WIDGET-001",
            productId: "8f14e45f-ceea-467a-9a5f-1b8f1c2a3d4e",
            warehouse: "default",
            quantity: 25,
            reorderLevel: 5,
          },
        }),
        responses: {
          "201": successResponse("The new stock record.", {
            $ref: "#/components/schemas/InventoryItem",
          }),
          ...errorResponses("400", "401", "403", "409", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/inventory/sku/{sku}`]: {
      parameters: parametersFrom(skuParamsSchema, "path"),
      get: {
        tags: ["Inventory"],
        operationId: "getInventoryBySku",
        summary: "Fetch a stock record by SKU",
        description: "Declared before `/{id}` in the router so the literal segment is not shadowed.",
        security: [{ bearerAuth: [] }],
        responses: {
          ...itemResponses,
          ...errorResponses("401", "404", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/inventory/{id}`]: {
      parameters: idParameters,
      get: {
        tags: ["Inventory"],
        operationId: "getInventoryItem",
        summary: "Fetch a stock record",
        security: [{ bearerAuth: [] }],
        responses: {
          ...itemResponses,
          ...errorResponses("401", "404", "422", "429", "500", "503"),
        },
      },
      patch: {
        tags: ["Inventory"],
        operationId: "updateInventoryItem",
        summary: "Patch a stock record",
        description:
          "Every accepted field is diffed against the stored row and written to the audit log, and a `quantity` edit additionally lands in the stock ledger as an `ADJUSTMENT`. A hand-edited quantity must still cover what is already reserved, and that check runs inside the same transaction as the write, so a concurrent reservation cannot slip between them.\n\nAt least one field must be present; an empty body is a 422, not a successful no-op.",
        security: [{ bearerAuth: [] }],
        parameters: [actorHeaderParameter],
        requestBody: jsonBody(updateInventoryItemSchema, {
          example: { reorderLevel: 10, warehouse: "north" },
        }),
        responses: {
          ...itemResponses,
          ...errorResponses("400", "401", "403", "404", "409", "413", "422", "429", "500", "503"),
        },
      },
      delete: {
        tags: ["Inventory"],
        operationId: "deleteInventoryItem",
        summary: "Delete a stock record",
        description:
          "Refused with a 409 while reservations are outstanding. Deleting cascades to this item's ledger and audit trail.",
        security: [{ bearerAuth: [] }],
        responses: {
          "204": noContentResponse,
          ...errorResponses("401", "403", "404", "409", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/inventory/{id}/audit-logs`]: {
      parameters: idParameters,
      get: {
        tags: ["History"],
        operationId: "listInventoryAuditLogs",
        summary: "Field-level change trail",
        description: "Who changed which column, and from what to what. Narrow it with `?field=`.",
        security: [{ bearerAuth: [] }],
        parameters: parametersFrom(listAuditLogsQuerySchema, "query"),
        responses: {
          "200": paginatedResponse("A page of audit entries.", {
            $ref: "#/components/schemas/InventoryAuditLog",
          }),
          ...errorResponses("401", "404", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/inventory/{id}/movements`]: {
      parameters: idParameters,
      get: {
        tags: ["History"],
        operationId: "listStockMovements",
        summary: "Stock ledger",
        description: "Every movement recorded against this item, newest first.",
        security: [{ bearerAuth: [] }],
        parameters: parametersFrom(listMovementsQuerySchema, "query"),
        responses: {
          "200": paginatedResponse("A page of ledger entries.", {
            $ref: "#/components/schemas/StockMovement",
          }),
          ...errorResponses("401", "404", "422", "429", "500", "503"),
        },
      },
    },

    ...transitionPaths,

    [`${API_PREFIX}/inventory/{id}/adjust`]: {
      parameters: idParameters,
      post: {
        tags: ["Stock movements"],
        operationId: "adjustStock",
        summary: "Apply a signed correction",
        description:
          "A stock count came back different. `delta` is signed — negative reduces on-hand stock — may not be zero, and a reason is mandatory, because an unexplained correction is indistinguishable from a bug. Refused with a 409 when it would leave fewer units on hand than are already reserved.",
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody(adjustStockSchema, {
          example: { delta: -3, reason: "Cycle count 2026-08-31: three units damaged" },
        }),
        responses: {
          ...itemResponses,
          ...errorResponses("400", "401", "403", "404", "409", "413", "422", "429", "500", "503"),
        },
      },
    },
  },
};
