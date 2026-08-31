import { z, type ZodType } from "zod";

/**
 * Small OpenAPI 3.1 authoring helpers, shared in shape by every service in the
 * repo.
 *
 * The point of this file is that request documentation is *derived*, never
 * re-typed: every request body, query string and path parameter below is
 * produced from the same Zod schema the router validates with, so a rule that
 * changes in `*.schema.ts` cannot go on being documented the old way.
 *
 * Response bodies are hand-written. They are shaped by the service layer and
 * the Prisma models rather than by a Zod schema, so there is nothing to derive
 * them from — see the `components.schemas` block in `openapi.ts`.
 */

export type JsonSchema = Record<string, unknown>;
export type OpenApiDocument = Record<string, unknown>;

export interface OpenApiParameter {
  name: string;
  in: "query" | "path" | "header";
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

/**
 * JSON Schema for the *input* side of a Zod schema.
 *
 * `io: "input"` is not a detail. Several schemas end in a `.transform()` —
 * upper-casing a SKU, lower-casing an email — and a transform's output has no
 * JSON Schema representation at all, so the default (`"output"`) throws. The
 * input side is also the only side a client can act on: it is what they have
 * to send.
 *
 * `$schema` is stripped because an OpenAPI 3.1 document declares its dialect
 * once, at the top, rather than on every subschema.
 */
export function jsonSchema(schema: ZodType): JsonSchema {
  const converted = z.toJSONSchema(schema, {
    io: "input",
    target: "draft-2020-12",
  }) as JsonSchema;

  const { $schema: _dialect, ...rest } = converted;
  return rest;
}

/**
 * Flattens an object schema into one OpenAPI parameter per property.
 *
 * Path parameters are always marked required — they are part of the URL, so
 * "optional" is not a state they can be in — regardless of what the Zod schema
 * says.
 */
export function parametersFrom(
  schema: ZodType,
  location: "query" | "path",
): OpenApiParameter[] {
  const converted = jsonSchema(schema);
  const properties = (converted["properties"] ?? {}) as Record<string, JsonSchema>;
  const required = new Set((converted["required"] as string[] | undefined) ?? []);

  return Object.entries(properties).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: location,
      required: location === "path" ? true : required.has(name),
      ...(typeof description === "string" ? { description } : {}),
      schema: rest,
    };
  });
}

/** A required `application/json` request body, derived from a Zod schema. */
export function jsonBody(
  schema: ZodType,
  options: { description?: string; example?: unknown } = {},
): JsonSchema {
  return {
    required: true,
    ...(options.description ? { description: options.description } : {}),
    content: {
      "application/json": {
        schema: jsonSchema(schema),
        ...(options.example !== undefined ? { example: options.example } : {}),
      },
    },
  };
}

/** `{ success: true, data }` — the envelope `utils/api-response.ts` writes. */
export function successResponse(
  description: string,
  data: JsonSchema,
  example?: unknown,
): JsonSchema {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["success", "data"],
          properties: { success: { type: "boolean", const: true }, data },
        },
        ...(example !== undefined ? { example } : {}),
      },
    },
  };
}

/** `{ success: true, data: [...], meta }` — the `sendPaginated` envelope. */
export function paginatedResponse(description: string, item: JsonSchema): JsonSchema {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["success", "data", "meta"],
          properties: {
            success: { type: "boolean", const: true },
            data: { type: "array", items: item },
            meta: { $ref: "#/components/schemas/PaginationMeta" },
          },
        },
      },
    },
  };
}

export const noContentResponse: JsonSchema = {
  description: "No content. The operation succeeded and there is nothing to return.",
};

/**
 * The failure catalogue, keyed by status code.
 *
 * Every entry renders the same `ErrorBody` the terminal error handler writes;
 * only the description differs. Declaring them here rather than per-operation
 * keeps the wording consistent across five services.
 */
const ERROR_DESCRIPTIONS: Record<string, string> = {
  "400": "Malformed request — unparseable JSON, or a body the parsers rejected.",
  "401": "No access token, or one that failed verification.",
  "403": "Authenticated, but the caller's role does not permit this.",
  "404": "No such resource.",
  "409": "The request conflicts with the current state — a duplicate key, or a precondition the resource does not meet.",
  "413": "Request body larger than the configured limit.",
  "422": "Validation failed. `error.details` names the offending fields.",
  "429": "Rate limit exceeded.",
  "500": "Unexpected server error. In production the message is generic on purpose.",
  "502": "An upstream was reached but its reply was unusable.",
  "503": "An upstream never accepted the request — it is unreachable. Safe to retry.",
  "504": "An upstream accepted the request and then ran out of time. A write may still have landed, so a blind retry is not safe.",
};

/** Error responses for the given status codes, ready to spread into `responses`. */
export function errorResponses(...statuses: Array<keyof typeof ERROR_DESCRIPTIONS>): JsonSchema {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        description: ERROR_DESCRIPTIONS[status] ?? "Request failed.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } },
        },
      },
    ]),
  );
}

/** Components every service shares: the error envelope and the pagination meta. */
export const commonSchemas: Record<string, JsonSchema> = {
  ErrorBody: {
    type: "object",
    description:
      "The single failure shape. Every non-2xx response in this service has this body.",
    required: ["success", "error"],
    properties: {
      success: { type: "boolean", const: false },
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            description: "Machine-readable. Branch on this, never on `message`.",
            enum: [
              "BAD_REQUEST",
              "VALIDATION_ERROR",
              "UNAUTHORIZED",
              "FORBIDDEN",
              "NOT_FOUND",
              "CONFLICT",
              "UNPROCESSABLE_ENTITY",
              "TOO_MANY_REQUESTS",
              "INTERNAL_SERVER_ERROR",
              "SERVICE_UNAVAILABLE",
              "BAD_GATEWAY",
              "GATEWAY_TIMEOUT",
            ],
          },
          message: { type: "string" },
          details: {
            type: "array",
            description: "Per-field breakdown. Present on validation and constraint failures.",
            items: {
              type: "object",
              required: ["message"],
              properties: {
                field: { type: "string" },
                message: { type: "string" },
                code: { type: "string" },
              },
              additionalProperties: true,
            },
          },
          requestId: {
            type: "string",
            description: "Correlation id, echoed in the `x-request-id` response header.",
          },
          stack: {
            type: "string",
            description: "Present outside production only.",
          },
        },
      },
    },
  },

  PaginationMeta: {
    type: "object",
    required: ["page", "limit", "total", "totalPages", "hasNextPage", "hasPreviousPage"],
    properties: {
      page: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
      total: { type: "integer", minimum: 0 },
      totalPages: { type: "integer", minimum: 0 },
      hasNextPage: { type: "boolean" },
      hasPreviousPage: { type: "boolean" },
    },
  },
};

/**
 * The bearer scheme every service documents.
 *
 * Only the auth service verifies these itself. Elsewhere the check happens at
 * the gateway, which is why the description says where the enforcement lives —
 * calling a "protected" endpoint directly on its own port succeeds.
 */
export const bearerAuthScheme: JsonSchema = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description:
    "Access token minted by the auth service (`POST /api/v1/auth/login`). Send it as `Authorization: Bearer <token>`. The gateway verifies it locally — signature, issuer, audience, expiry — and never calls the auth service to do so.",
};

/** The service banner at `/`, identical in shape across the repo. */
export function rootPath(serviceName: string, extraProperties: Record<string, JsonSchema> = {}): JsonSchema {
  return {
    get: {
      tags: ["Meta"],
      operationId: "serviceBanner",
      summary: "Service banner",
      // An empty array is not the same as omitting `security`: it says "this
      // operation requires no credentials", which is a fact worth stating.
      security: [],
      description: "Name, version and API prefix. Unversioned on purpose — it is what you hit to find out what is listening.",
      responses: {
        "200": successResponse(`${serviceName} is listening.`, {
          type: "object",
          properties: {
            service: { type: "string", example: serviceName },
            version: { type: "string", example: "1.0.0" },
            apiPrefix: { type: "string", example: "/api/v1" },
            ...extraProperties,
          },
        }),
      },
    },
  };
}

/**
 * `/health`, `/health/live` and `/health/ready`, which are byte-identical
 * across the repo — see each service's `modules/health/health.routes.ts`.
 *
 * The split matters operationally: liveness answers "should this process be
 * restarted", readiness answers "should traffic be sent here". Wiring a load
 * balancer to the wrong one either restarts a healthy process or routes to one
 * that cannot serve.
 */
export function healthPaths(apiPrefix: string, serviceName: string): Record<string, JsonSchema> {
  const liveness = (operationId: string): JsonSchema => ({
    get: {
      tags: ["Health"],
      operationId,
      summary: "Liveness probe",
      security: [],
      description: "Answers as long as the process is up. Never touches a dependency.",
      responses: {
        "200": successResponse("The process is running.", {
          type: "object",
          required: ["status", "service", "uptimeSeconds"],
          properties: {
            status: { type: "string", const: "ok" },
            service: { type: "string", example: serviceName },
            uptimeSeconds: { type: "integer", minimum: 0 },
          },
        }),
      },
    },
  });

  return {
    [`${apiPrefix}/health`]: liveness("healthRoot"),
    [`${apiPrefix}/health/live`]: liveness("healthLive"),
    [`${apiPrefix}/health/ready`]: {
      get: {
        tags: ["Health"],
        operationId: "healthReady",
        summary: "Readiness probe",
        security: [],
        description:
          "Checks the dependencies this service cannot serve without. A 503 here means stop sending traffic, not restart the process.",
        responses: {
          "200": successResponse("Every dependency answered.", {
            type: "object",
            required: ["status", "dependencies"],
            properties: {
              status: { type: "string", const: "ready" },
              dependencies: {
                type: "object",
                additionalProperties: { type: "string" },
                example: { database: "up" },
              },
            },
          }),
          ...errorResponses("503"),
        },
      },
    },
  };
}
