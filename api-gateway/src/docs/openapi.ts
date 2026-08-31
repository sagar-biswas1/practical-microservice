import { env } from "../config/env.js";
import { API_PREFIX, serviceRegistry } from "../config/services.js";
import { routePolicies } from "../config/route-policies.js";
import {
  bearerAuthScheme,
  commonSchemas,
  errorResponses,
  rootPath,
  successResponse,
  type JsonSchema,
  type OpenApiDocument,
} from "./openapi-helpers.js";

/**
 * The routing table, rendered as Markdown for `info.description`.
 *
 * Generated from `serviceRegistry` rather than re-typed, so a service added to
 * the gateway shows up here the same day it starts being forwarded.
 */
function routingTable(): string {
  const rows = serviceRegistry.map(
    ({ name, prefix, target }) => `| \`${name}\` | \`${prefix}/*\` | ${target} |`,
  );

  return ["| Upstream | Path prefix | Target |", "| --- | --- | --- |", ...rows].join("\n");
}

/**
 * The edge policies, rendered from the same table the middleware runs off.
 *
 * A policy that changes in `config/route-policies.ts` therefore changes here
 * too — which matters more than usual, because the whole point of that file is
 * that "which routes need a token?" is a question you cannot forget to answer.
 */
function policyTable(): string {
  const rows = Object.entries(routePolicies).flatMap(([service, policies]) =>
    policies.map((policy) => {
      const methods = policy.methods?.join(", ") ?? "any";
      const paths = policy.paths.map((path) => `\`${path}\``).join(", ");
      return `| \`${service}\` | ${policy.name} | ${methods} | ${paths} |`;
    }),
  );

  return ["| Upstream | Policy | Methods | Paths (relative to the prefix) |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

const dependencyStatus: JsonSchema = {
  type: "object",
  required: ["status", "latencyMs"],
  properties: {
    status: { type: "string", enum: ["up", "down"] },
    latencyMs: { type: "integer", minimum: 0 },
    message: { type: "string", description: "Why the probe failed. Absent when it did not." },
  },
};

const liveness = (operationId: string): JsonSchema => ({
  get: {
    tags: ["Health"],
    operationId,
    summary: "Liveness probe",
    security: [],
    description:
      "Deliberately ignores the upstreams. A gateway whose dependencies are down is still a healthy process, and restarting it would not help.\n\nMounted ahead of the rate limiter, so a probe on a fixed schedule is never throttled.",
    responses: {
      "200": successResponse("The process is running.", {
        type: "object",
        required: ["status", "service", "uptimeSeconds"],
        properties: {
          status: { type: "string", const: "ok" },
          service: { type: "string", example: env.SERVICE_NAME },
          uptimeSeconds: { type: "integer", minimum: 0 },
        },
      }),
    },
  },
});

export const openapiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "API gateway",
    version: "1.0.0",
    description: [
      "The single public entry point. It owns no database and stores nothing: it verifies access tokens, enforces a per-route policy, and forwards what survives.",
      "",
      "**This document covers the gateway's own endpoints only.** Everything under `/api/v1/*` belongs to an upstream and is documented by that upstream — use the definition picker at the top of this page to switch to one. Paths are forwarded verbatim, with no rewriting, so a path documented there is the same path here.",
      "",
      "### Routing",
      "",
      routingTable(),
      "",
      "### What the edge enforces",
      "",
      "Two rules shape the table below. **The gateway decides who you are; the service decides what you may do with its data** — the edge can prove a token is valid and read a role off it, but it cannot know whether user `A` owns order `B` without asking the service that owns the answer, and an edge that starts making those calls stops being a router. Identity is forwarded as `x-actor-id` and the service does the rest. And **a route is public only if it has to be**: policies are declared per path rather than as a default-open list with exceptions, so a new upstream endpoint is unprotected only when someone writes it that way.",
      "",
      policyTable(),
      "",
      "### Two limits, not one",
      "",
      `A general ceiling of ${env.RATE_LIMIT_MAX} requests per ${Math.round(env.RATE_LIMIT_WINDOW_MS / 1000)}s applies to everything past the health routes. The credential endpoints — login, registration, refresh, password reset, verification — share one much tighter bucket (${env.AUTH_RATE_LIMIT_MAX} per ${Math.round(env.AUTH_RATE_LIMIT_WINDOW_MS / 60000)} minutes). One bucket covers all of them together, so rotating between \`/login\` and \`/forgot-password\` does not buy an attacker a fresh allowance.`,
      "",
      "### Bodies are never parsed here",
      "",
      "The proxy pipes the request stream to the upstream untouched — parsing it would consume the stream and leave the proxied request hanging with no payload. Only the declared size is inspected, against a blunt edge limit sized above the upstreams' own; the service that understands the payload does the precise rejecting.",
    ].join("\n"),
  },
  servers: [{ url: `http://localhost:${env.PORT}`, description: "The gateway" }],
  tags: [
    { name: "Health", description: "Liveness, and readiness across every upstream." },
    { name: "Meta", description: "Service banner and the routing table." },
  ],
  components: {
    securitySchemes: { bearerAuth: bearerAuthScheme },
    // Only the error envelope: the gateway paginates nothing of its own.
    schemas: { ErrorBody: commonSchemas["ErrorBody"], DependencyStatus: dependencyStatus },
  },
  paths: {
    "/": rootPath(env.SERVICE_NAME, {
      upstreams: {
        type: "array",
        description: "The routing table, as the gateway currently holds it.",
        items: {
          type: "object",
          properties: { name: { type: "string" }, prefix: { type: "string" } },
        },
      },
    }),

    [`${API_PREFIX}/health`]: liveness("gatewayHealthRoot"),
    [`${API_PREFIX}/health/live`]: liveness("gatewayHealthLive"),
    [`${API_PREFIX}/health/ready`]: {
      get: {
        tags: ["Health"],
        operationId: "gatewayHealthReady",
        summary: "Readiness probe across every upstream",
        security: [],
        description:
          "Probes each registered upstream's liveness endpoint concurrently. A probe never throws — a down dependency is a reportable state, not an error, and one unreachable service must not hide the status of the others.\n\nThe 503 body carries both the standard `error` envelope *and* a `data` block with the full report, so an operator sees which upstream is down without a second request.",
        responses: {
          "200": successResponse("Every upstream answered.", {
            type: "object",
            required: ["status", "dependencies"],
            properties: {
              status: { type: "string", const: "ready" },
              dependencies: {
                type: "object",
                additionalProperties: { $ref: "#/components/schemas/DependencyStatus" },
              },
            },
          }),
          "503": {
            description: "At least one upstream is unreachable.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/ErrorBody" },
                    {
                      type: "object",
                      properties: {
                        data: {
                          type: "object",
                          required: ["status", "dependencies"],
                          properties: {
                            status: { type: "string", const: "degraded" },
                            dependencies: {
                              type: "object",
                              additionalProperties: {
                                $ref: "#/components/schemas/DependencyStatus",
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },

    [`${API_PREFIX}/{upstreamPath}`]: {
      parameters: [
        {
          name: "upstreamPath",
          in: "path",
          required: true,
          description:
            "Anything under a registered prefix — `auth/…`, `users/…`, `products/…`, `inventory/…`, `emails/…`.",
          schema: { type: "string" },
        },
      ],
      get: {
        tags: ["Meta"],
        operationId: "proxiedUpstream",
        summary: "Anything else — forwarded to the upstream that owns the prefix",
        description:
          "A placeholder, not a real operation. Every method is forwarded, path-for-path, to the service that owns the prefix; the request and response bodies are that service's. Switch definitions using the picker at the top of this page to see them.\n\nThe responses listed here are the ones the *gateway itself* can produce before an upstream is ever contacted.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "Whatever the upstream returned." },
          ...errorResponses("401", "403", "413", "429"),
          "404": {
            description: "No registered prefix owns this path.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } },
            },
          },
          "502": {
            description: "The upstream could not be reached.",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } },
            },
          },
          "504": {
            description: `The upstream did not answer within ${env.PROXY_TIMEOUT_MS}ms.`,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ErrorBody" } },
            },
          },
        },
      },
    },
  },
};
