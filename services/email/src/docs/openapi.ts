import { env } from "../config/env.js";
import { API_PREFIX } from "../routes/index.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
} from "../modules/email/email.controller.js";
import {
  emailIdParamsSchema,
  listEmailsQuerySchema,
  sendEmailSchema,
  EMAIL_BODY_TYPES,
  EMAIL_STATUSES,
} from "../modules/email/email.schema.js";
import {
  bearerAuthScheme,
  commonSchemas,
  errorResponses,
  healthPaths,
  jsonBody,
  paginatedResponse,
  parametersFrom,
  rootPath,
  successResponse,
  type JsonSchema,
  type OpenApiDocument,
} from "./openapi-helpers.js";

const idParameters = parametersFrom(emailIdParamsSchema, "path");

const idempotencyKeyParameter: JsonSchema = {
  name: IDEMPOTENCY_KEY_HEADER,
  in: "header",
  required: false,
  description:
    "Caller-supplied de-duplication token, 8–255 characters. Optional: omitting it simply means no replay protection, which is the right default for a one-off `curl` and the wrong one for a service that retries on timeout.\n\nThe key is written in the same transaction as the message it creates, so there is no window in which one exists without the other. Reusing a key with a *different* payload is a 409 — that is a bug on the caller's side, and quietly returning the first message would hide it.",
  schema: { type: "string", minLength: 8, maxLength: 255 },
};

const replayHeader: JsonSchema = {
  [IDEMPOTENT_REPLAY_HEADER]: {
    description: "Set to `true` when this response replayed an earlier request rather than creating one.",
    schema: { type: "string", enum: ["true"] },
  },
};

const emailMessage: JsonSchema = {
  type: "object",
  description: "One row of the transactional outbox, plus its dispatch bookkeeping.",
  required: [
    "id",
    "recipient",
    "subject",
    "body",
    "bodyType",
    "source",
    "status",
    "attempts",
    "maxAttempts",
    "nextAttemptAt",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    recipient: { type: "string", format: "email", maxLength: 320, description: "Stored lower-cased." },
    subject: { type: "string", maxLength: 255 },
    body: { type: "string" },
    bodyType: { type: "string", enum: [...EMAIL_BODY_TYPES] },
    source: {
      type: "string",
      maxLength: 100,
      description: "Who asked for this — a service or event name. Purely descriptive, but it is what makes \"which part of the system is mailing this person\" answerable.",
    },
    status: {
      type: "string",
      enum: [...EMAIL_STATUSES],
      description:
        "`PENDING` → `SENDING` → `SENT`, or → `FAILED` → `SENDING` → …, or → `DEAD`. Every transition is one-way except the operator-driven retry, which returns a `DEAD` or `FAILED` row to `PENDING`.",
    },
    attempts: { type: "integer", description: "Completed attempts, incremented after each send returns." },
    maxAttempts: {
      type: "integer",
      description:
        "Copied from config at enqueue time, so raising the default later does not silently revive rows already declared dead.",
    },
    nextAttemptAt: {
      type: "string",
      format: "date-time",
      description:
        "Earliest time a dispatcher may claim this row. Backoff is expressed by pushing this forward rather than by sleeping, so a restart cannot lose it.",
    },
    lockedAt: { type: ["string", "null"], format: "date-time" },
    lockedBy: { type: ["string", "null"], description: "Which dispatcher instance holds the claim." },
    lastError: { type: ["string", "null"], maxLength: 1000, description: "A breadcrumb for an operator, not a log sink." },
    provider: { type: ["string", "null"], description: "Recorded per row: the provider can be swapped while messages are still in flight." },
    providerMessageId: { type: ["string", "null"] },
    sentAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const statusCounts: JsonSchema = {
  type: "object",
  description: "Outbox depth by status — what a dashboard or an alert rule watches.",
  required: [...EMAIL_STATUSES],
  properties: Object.fromEntries(
    EMAIL_STATUSES.map((status) => [status, { type: "integer", minimum: 0 }]),
  ),
};

export const openapiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Email service",
    version: "1.0.0",
    description: [
      "A transactional outbox and the relay that drains it. This service calls no other service; the auth service calls it.",
      "",
      "**`POST /emails` answers `202`, not `201`, and the difference is the whole design.** The request writes a row and commits — nothing has been sent to a mail provider at that point. A background dispatcher claims due rows afterwards and makes the network call. The database can guarantee atomicity for its own writes and can guarantee nothing about an HTTP call to a third party, so the two are never mixed into one unit of work. `GET /emails/{id}` is how a caller finds out what happened next.",
      "",
      "**Retries are the normal case, so send an `Idempotency-Key`.** It is the only thing standing between a network blip on the caller's side and a duplicate email.",
      "",
      "**Where authentication is enforced.** This service does not verify tokens; the api-gateway does, and it requires `ADMIN` for everything here. The surface is entirely an operations one — the queue, its statistics, and a retry button — because the things that actually send email are other services calling this one directly.",
    ].join("\n"),
  },
  servers: [
    { url: "http://localhost:4000", description: "Through the api-gateway (token verified at the edge)" },
    { url: `http://localhost:${env.PORT}`, description: "Direct — development only" },
  ],
  tags: [
    { name: "Outbox", description: "Enqueueing and inspecting messages." },
    { name: "Dispatch", description: "Driving and repairing delivery." },
    { name: "Health", description: "Liveness and readiness probes." },
    { name: "Meta", description: "Service banner." },
  ],
  components: {
    securitySchemes: { bearerAuth: bearerAuthScheme },
    schemas: { ...commonSchemas, EmailMessage: emailMessage, StatusCounts: statusCounts },
  },
  paths: {
    "/": rootPath(env.SERVICE_NAME, {
      provider: { type: "string", example: env.EMAIL_PROVIDER },
    }),
    ...healthPaths(API_PREFIX, env.SERVICE_NAME),

    [`${API_PREFIX}/emails`]: {
      post: {
        tags: ["Outbox"],
        operationId: "sendEmail",
        summary: "Accept a message into the outbox",
        description:
          "Writes and commits the row. Nothing is sent inside this request.\n\nEvery length limit on the body below is a column width from `prisma/schema.prisma`, one for one, so an over-long subject is a 422 naming the field rather than a Postgres `value too long` surfacing as a 500 after the request was already accepted. The `body` ceiling is config-driven (`EMAIL_MAX_BODY_CHARS`) because it is a policy decision, not a schema fact — a transactional deployment and a newsletter one want different numbers.",
        security: [{ bearerAuth: [] }],
        parameters: [idempotencyKeyParameter],
        requestBody: jsonBody(sendEmailSchema, {
          example: {
            recipient: "ada@example.com",
            subject: "Verify your email address",
            body: "Your code is 123456. It expires in 15 minutes.",
            bodyType: "TEXT",
            source: "auth-service",
          },
        }),
        responses: {
          "200": {
            ...(successResponse(
              "Replayed. An identical request had already been accepted under this idempotency key, so nothing was created this time round.",
              { $ref: "#/components/schemas/EmailMessage" },
            ) as Record<string, unknown>),
            headers: replayHeader,
          },
          "202": successResponse("Accepted into the outbox. Not yet sent.", {
            $ref: "#/components/schemas/EmailMessage",
          }),
          ...errorResponses("400", "401", "403", "409", "413", "422", "429", "500", "503"),
        },
      },
      get: {
        tags: ["Outbox"],
        operationId: "listEmails",
        summary: "List messages",
        description: "Newest first. Filter by status, source or recipient.",
        security: [{ bearerAuth: [] }],
        parameters: parametersFrom(listEmailsQuerySchema, "query"),
        responses: {
          "200": paginatedResponse("A page of messages.", {
            $ref: "#/components/schemas/EmailMessage",
          }),
          ...errorResponses("401", "403", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/emails/stats`]: {
      get: {
        tags: ["Outbox"],
        operationId: "emailStats",
        summary: "Outbox depth by status",
        description:
          "Declared before `/{id}` in the router. The id schema would reject `stats` as a non-UUID anyway, but relying on that would make the routing depend on the shape of an identifier that could change.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": successResponse("Counts per status.", { $ref: "#/components/schemas/StatusCounts" }),
          ...errorResponses("401", "403", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/emails/dispatch`]: {
      post: {
        tags: ["Dispatch"],
        operationId: "runDispatchCycle",
        summary: "Run one dispatch cycle on demand",
        description:
          "**Registered only when a dispatcher is wired in** — otherwise this path 404s rather than existing in a form that cannot work. Useful when the background loop is disabled and delivery is driven by an external scheduler, and useful in development for not waiting out the poll interval.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": successResponse("What the cycle did.", {
            type: "object",
            required: ["claimed", "sent", "retrying", "dead"],
            properties: {
              claimed: { type: "integer", description: "Rows this cycle took ownership of." },
              sent: { type: "integer" },
              retrying: { type: "integer", description: "Failed, but with attempts left." },
              dead: { type: "integer", description: "Retries exhausted, or rejected in a way retrying cannot fix." },
            },
          }),
          ...errorResponses("401", "403", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/emails/{id}`]: {
      parameters: idParameters,
      get: {
        tags: ["Outbox"],
        operationId: "getEmail",
        summary: "Fetch one message",
        description: "How a caller that got a `202` finds out what happened to it.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": successResponse("The message.", { $ref: "#/components/schemas/EmailMessage" }),
          ...errorResponses("401", "403", "404", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/emails/{id}/retry`]: {
      parameters: idParameters,
      post: {
        tags: ["Dispatch"],
        operationId: "retryEmail",
        summary: "Return a dead or failed message to the queue",
        description:
          "The one transition that runs backwards, and it is operator-driven on purpose. Only `FAILED` and `DEAD` rows may be revived; anything else is a 409.",
        security: [{ bearerAuth: [] }],
        responses: {
          "202": successResponse("Requeued.", { $ref: "#/components/schemas/EmailMessage" }),
          ...errorResponses("401", "403", "404", "409", "422", "429", "500", "503"),
        },
      },
    },
  },
};
