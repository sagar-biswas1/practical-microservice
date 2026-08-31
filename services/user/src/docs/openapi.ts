import { env } from "../config/env.js";
import { API_PREFIX } from "../routes/index.js";
import {
  authUserIdParamsSchema,
  createUserSchema,
  updateUserSchema,
  userIdParamsSchema,
} from "../modules/user/user.schema.js";
import {
  bearerAuthScheme,
  commonSchemas,
  errorResponses,
  healthPaths,
  jsonBody,
  noContentResponse,
  parametersFrom,
  rootPath,
  successResponse,
  type JsonSchema,
  type OpenApiDocument,
} from "./openapi-helpers.js";

const user: JsonSchema = {
  type: "object",
  description: "A profile. The login behind it lives in the auth service.",
  required: ["id", "authUserId", "name", "email", "address", "phone", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", format: "uuid", description: "Minted here; never supplied by a caller." },
    authUserId: {
      type: "string",
      maxLength: 191,
      description:
        "The auth service's user id. Unique, and not patchable — re-pointing a profile at a different login is an account merge, not a field edit.",
    },
    name: { type: "string", maxLength: 150 },
    email: { type: "string", format: "email", maxLength: 150, description: "Unique, stored lower-cased." },
    address: { type: "string", maxLength: 250 },
    phone: { type: "string", maxLength: 20 },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const userResponse = successResponse("The profile.", { $ref: "#/components/schemas/User" });

export const openapiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "User service",
    version: "1.0.0",
    description: [
      "Profiles — name, address, phone, email — keyed by the auth service's user id. This service calls nobody.",
      "",
      "**It does not own the login.** Passwords, sessions and verification live in the auth service; this one holds only what a login is not. The two are joined by `authUserId`, a soft reference with no foreign key behind it, because the row it points at is in another service's schema.",
      "",
      "**Its main caller is the auth service, not a browser.** A profile is created during registration, once the account verifies, by a direct server-to-server call that does not pass through the gateway. That is why the create and auth-id-lookup endpoints are closed to public traffic at the edge without anything legitimate breaking.",
      "",
      "**Where authentication is enforced.** This service does not verify tokens; the api-gateway does. `POST /users` and `GET /users/auth/{authUserId}` require `ADMIN` there — resolving a profile from an auth user id publicly would turn auth ids into an enumeration handle. `/users/{id}` requires a token, and whether *this* caller may read or edit *that* profile is this service's call to make, not the edge's.",
    ].join("\n"),
  },
  servers: [
    {
      url: "http://localhost:4000",
      description: "Through the api-gateway (token verified at the edge)",
    },
    {
      url: `http://localhost:${env.PORT}`,
      description: "Direct — development only",
    },
  ],
  tags: [
    { name: "Users", description: "Profiles." },
    { name: "Health", description: "Liveness and readiness probes." },
    { name: "Meta", description: "Service banner." },
  ],
  components: {
    securitySchemes: { bearerAuth: bearerAuthScheme },
    schemas: { ...commonSchemas, User: user },
  },
  paths: {
    "/": rootPath(env.SERVICE_NAME),
    ...healthPaths(API_PREFIX, env.SERVICE_NAME),

    [`${API_PREFIX}/users`]: {
      post: {
        tags: ["Users"],
        operationId: "createUser",
        summary: "Create a profile",
        description:
          "Called by the auth service when an account verifies. `email` and `authUserId` are both unique, so a retried hand-off is rejected by the database rather than producing a second profile for one login.",
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody(createUserSchema, {
          example: {
            authUserId: "0f4b2c9e-6a1d-4b3e-8c7f-2d5a9e1b3c4d",
            name: "Ada Lovelace",
            email: "delivered@resend.dev",
            address: "12 Analytical Way, London",
            phone: "+44 20 7946 0958",
          },
        }),
        responses: {
          "201": successResponse("The new profile.", {
            $ref: "#/components/schemas/User",
          }),
          ...errorResponses(
            "400",
            "401",
            "403",
            "409",
            "413",
            "422",
            "429",
            "500",
            "503",
          ),
        },
      },
    },

    [`${API_PREFIX}/users/auth/{authUserId}`]: {
      parameters: parametersFrom(authUserIdParamsSchema, "path"),
      get: {
        tags: ["Users"],
        operationId: "getUserByAuthUserId",
        summary: "Resolve a profile from an auth user id",
        description:
          "Two path segments, so it cannot be shadowed by `/{id}`. The id comes from the identity provider, so its format is not this service's to dictate — it is length-checked only.",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": userResponse,
          ...errorResponses("401", "403", "404", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/users/{id}`]: {
      parameters: parametersFrom(userIdParamsSchema, "path"),
      get: {
        tags: ["Users"],
        operationId: "getUser",
        summary: "Fetch a profile",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": userResponse,
          ...errorResponses("401", "404", "422", "429", "500", "503"),
        },
      },
      patch: {
        tags: ["Users"],
        operationId: "updateUser",
        summary: "Update a profile",
        description:
          "At least one field must be present; an empty body is a 422, not a successful no-op. `authUserId` is not patchable.",
        security: [{ bearerAuth: [] }],
        requestBody: jsonBody(updateUserSchema, {
          example: { address: "24 Difference Engine Road, London" },
        }),
        responses: {
          "200": successResponse("The updated profile.", {
            $ref: "#/components/schemas/User",
          }),
          ...errorResponses(
            "400",
            "401",
            "404",
            "409",
            "413",
            "422",
            "429",
            "500",
            "503",
          ),
        },
      },
      delete: {
        tags: ["Users"],
        operationId: "deleteUser",
        summary: "Delete a profile",
        description:
          "Removes the profile only. The login in the auth service is untouched, and its `userId` will still point here — the two are reconciled by the services, not by a foreign key.",
        security: [{ bearerAuth: [] }],
        responses: {
          "204": noContentResponse,
          ...errorResponses("401", "404", "422", "429", "500", "503"),
        },
      },
    },
  },
};
