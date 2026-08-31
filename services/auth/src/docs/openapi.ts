import { env } from "../config/env.js";
import { API_PREFIX } from "../routes/index.js";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginHistoryQuerySchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  AUTH_USER_STATUSES,
  LOGIN_OUTCOMES,
  ROLES,
} from "../modules/auth/auth.schema.js";
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

const authUser: JsonSchema = {
  type: "object",
  description:
    "The public view of a login. Note what is absent: no password hash, no failed-attempt counter, no lock expiry — none of it is the client's business, and a field that is never serialised cannot be leaked by accident.",
  required: ["id", "email", "username", "role", "status", "verified", "userId", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email", description: "Unique, stored lower-cased." },
    username: {
      type: "string",
      description:
        "Unique and lower-cased. A display and lookup handle only — authentication goes through `email`.",
    },
    role: { type: "string", enum: [...ROLES] },
    status: {
      type: "string",
      enum: [...AUTH_USER_STATUSES],
      description:
        "Whether the account may authenticate at all — orthogonal to `verified`. A verified account can be `SUSPENDED`, and an unverified one is still `ACTIVE`; it simply cannot log in yet.",
    },
    verified: { type: "boolean", description: "True once an email verification code has been consumed." },
    userId: {
      type: ["string", "null"],
      description:
        "The user service's profile id, or null if the hand-off has not happened yet — either the account is unverified, or the call failed and the next login retries it.",
    },
    lastLoginAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
  },
};

const tokens: JsonSchema = {
  type: "object",
  required: ["accessToken", "refreshToken", "tokenType", "expiresIn"],
  properties: {
    accessToken: {
      type: "string",
      description:
        "Signed JWT. Verified by pure computation — signature, issuer, audience, expiry — so the gateway and every service can check it without a connection to this database. The cost is that it cannot see a revocation: a suspended account still passes until its token expires, which is why the TTL is short.",
    },
    refreshToken: {
      type: "string",
      description:
        "Opaque, returned once and never stored — only a SHA-256 of it is kept, so a dump of the token table grants nothing. Rotated on every use.",
    },
    tokenType: { type: "string", const: "Bearer" },
    expiresIn: { type: "integer", description: "Seconds until the access token expires." },
  },
};

const session: JsonSchema = {
  type: "object",
  description: "One live refresh-token session, as \"sign out my other devices\" would show it.",
  required: ["id", "createdAt", "expiresAt", "current"],
  properties: {
    id: { type: "string", format: "uuid" },
    ip: { type: ["string", "null"] },
    userAgent: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    current: { type: "boolean", description: "True for the session whose token made this request." },
  },
};

const loginHistoryEntry: JsonSchema = {
  type: "object",
  description:
    "One login attempt. Append-only, never updated after insert — it is the answer to \"was that you logging in from Lagos at 3am\", and an audit trail that gets edited is not one.",
  required: ["id", "email", "success", "outcome", "attempt", "loginAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    email: {
      type: "string",
      description: "The address as submitted. Kept verbatim, because an account can change its email and this must still say what was typed that day.",
    },
    success: { type: "boolean" },
    outcome: {
      type: "string",
      enum: [...LOGIN_OUTCOMES],
      description:
        "Recorded in full even though the *response* to a failed login is deliberately vague: \"no such email\" and \"wrong password\" must look identical from outside, but an operator investigating a lockout needs to know which it was.",
    },
    attempt: { type: "integer", description: "Which consecutive attempt this was for the account." },
    ip: { type: ["string", "null"] },
    userAgent: { type: ["string", "null"] },
    loginAt: { type: "string", format: "date-time" },
  },
};

const messageOnly = (example: string): JsonSchema => ({
  type: "object",
  required: ["message"],
  properties: { message: { type: "string", example } },
});

const authenticatedResult: JsonSchema = {
  type: "object",
  required: ["user", "tokens"],
  properties: {
    user: { $ref: "#/components/schemas/AuthUser" },
    tokens: { $ref: "#/components/schemas/AuthTokens" },
  },
};

/** Every authenticated operation shares these. */
const authenticated = {
  security: [{ bearerAuth: [] }],
} as const;

export const openapiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Auth service",
    version: "1.0.0",
    description: [
      "Logins, sessions and verification codes. This service owns the *login*, never the *profile*: name, address and phone belong to the user service, and appear here only as a parking space for data in transit at registration.",
      "",
      "**This is the one service that verifies tokens itself.** Everything below `GET /auth/me` requires a valid access token on `req.auth`; the gateway mirrors that split at the edge rather than inventing a different one. `POST /refresh` and `POST /logout` sit deliberately on the public side — both authenticate with the refresh token in the body, and requiring an *access* token would make them useless at exactly the moment they matter, when the access token has expired.",
      "",
      "**Several endpoints answer the same way whatever happened, on purpose.** `resend-verification` and `forgot-password` take an email address and nothing else, so any variation in their response is a membership oracle that needs no credentials to query. They always answer `202` — unknown address, already-verified account, cooldown still running, all alike. A failed login is equally uninformative for the same reason; the real outcome goes to `login_history`, where an operator can see it and an attacker cannot.",
      "",
      "**Refresh tokens rotate, and reuse is treated as theft.** A used token dies the moment its successor is issued, so presenting a dead one means two copies are in circulation. Which of the two is the thief is unknowable, so the whole token family is revoked and both are forced to log in again.",
    ].join("\n"),
  },
  servers: [
    { url: "http://localhost:4000", description: "Through the api-gateway (credential endpoints are rate-limited there)" },
    { url: `http://localhost:${env.PORT}`, description: "Direct — development only" },
  ],
  tags: [
    { name: "Registration", description: "Creating an account and proving the mailbox." },
    { name: "Sessions", description: "Logging in, refreshing, logging out." },
    { name: "Passwords", description: "Resetting and changing a password." },
    { name: "Account", description: "What the signed-in caller can see about themselves." },
    { name: "Health", description: "Liveness and readiness probes." },
    { name: "Meta", description: "Service banner." },
  ],
  components: {
    securitySchemes: { bearerAuth: bearerAuthScheme },
    schemas: {
      ...commonSchemas,
      AuthUser: authUser,
      AuthTokens: tokens,
      Session: session,
      LoginHistoryEntry: loginHistoryEntry,
    },
  },
  paths: {
    "/": rootPath(env.SERVICE_NAME),
    ...healthPaths(API_PREFIX, env.SERVICE_NAME),

    [`${API_PREFIX}/auth/register`]: {
      post: {
        tags: ["Registration"],
        operationId: "register",
        security: [],
        summary: "Create an account",
        description:
          "Creates the login and mails a verification code. The profile fields are validated here against the *user service's* constraints and then parked until the account verifies — so a bad address is a 422 while the user is still on the form, rather than a failed hand-off fifteen minutes later when there is no one left to correct it.\n\nPassword rules are a floor, a ceiling and a blocklist, with no composition requirements: NIST SP 800-63B recommends against those, and they mostly produce `Password1!`. The ceiling is not cosmetic — Argon2 hashes whatever it is given, so an unbounded password field is unbounded CPU per login attempt. A password containing the account's own username or email local-part is also rejected.\n\n`emailQueued: false` means the account exists but the code never reached the email service; the client should offer \"resend\" rather than leave the user waiting for mail that was never sent.",
        requestBody: jsonBody(registerSchema, {
          example: {
            email: "ada@example.com",
            username: "ada",
            password: "correct horse battery staple",
            profile: {
              name: "Ada Lovelace",
              address: "12 Analytical Way, London",
              phone: "+44 20 7946 0958",
            },
          },
        }),
        responses: {
          "201": successResponse("The account was created.", {
            type: "object",
            required: ["user", "emailQueued"],
            properties: {
              user: { $ref: "#/components/schemas/AuthUser" },
              emailQueued: {
                type: "boolean",
                description: "False when the verification code could not be handed to the email service.",
              },
            },
          }),
          ...errorResponses("400", "409", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/verify-email`]: {
      post: {
        tags: ["Registration"],
        operationId: "verifyEmail",
        security: [],
        summary: "Consume a verification code",
        description:
          "Flips `verified`, signs the caller in, and hands the parked profile to the user service. A wrong code burns an attempt; at the ceiling the code goes `EXPIRED`, so guessing costs the attacker a fresh email round-trip every few tries.\n\n`profileCreated: false` means the account is verified and usable and only the user-service profile is missing — the next login retries it.",
        requestBody: jsonBody(verifyEmailSchema, {
          example: { email: "ada@example.com", code: "123456" },
        }),
        responses: {
          "200": successResponse("Verified and signed in.", {
            type: "object",
            required: ["user", "tokens", "profileCreated"],
            properties: {
              user: { $ref: "#/components/schemas/AuthUser" },
              tokens: { $ref: "#/components/schemas/AuthTokens" },
              profileCreated: { type: "boolean" },
            },
          }),
          ...errorResponses("400", "401", "404", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/resend-verification`]: {
      post: {
        tags: ["Registration"],
        operationId: "resendVerification",
        security: [],
        summary: "Reissue a verification code",
        description:
          "**Always `202`, whatever happened** — unknown address, already-verified account, cooldown still running. This endpoint takes an email and nothing else, so any variation in its answer is an account-existence oracle that needs no credentials to query.\n\nThe cooldown is enforced all the same, silently: it is what stops the endpoint from being used to mail an arbitrary address as fast as HTTP allows.",
        requestBody: jsonBody(resendVerificationSchema, {
          example: { email: "ada@example.com" },
        }),
        responses: {
          "202": successResponse(
            "Accepted. Says nothing about whether the address exists.",
            messageOnly("If that address needs verifying, a new code is on its way."),
          ),
          ...errorResponses("400", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/login`]: {
      post: {
        tags: ["Sessions"],
        operationId: "login",
        security: [],
        summary: "Log in",
        description:
          "The password is bounded but otherwise unvalidated here. Applying the password *policy* to a login would reject an existing account whose password predates a rule change — with a 422 helpfully describing what their password looks like. The only thing that decides a login is the hash comparison.\n\nEvery attempt, successful or not, is written to the login history. Consecutive failures lock the account for a configured period, and a lock is refused even with the correct password.",
        requestBody: jsonBody(loginSchema, {
          example: { email: "ada@example.com", password: "correct horse battery staple" },
        }),
        responses: {
          "200": successResponse("Signed in.", authenticatedResult),
          ...errorResponses("400", "401", "403", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/refresh`]: {
      post: {
        tags: ["Sessions"],
        operationId: "refresh",
        security: [],
        summary: "Exchange a refresh token for a new pair",
        description:
          "Public on purpose: the refresh token in the body *is* the credential, and requiring an access token would make this useless precisely when it is needed.\n\nRotation means the presented token dies as its successor is issued. Presenting an already-rotated token is therefore proof that two copies exist — the whole family is revoked and this call fails with a 401. Account status is re-checked here, which is the window in which a suspension actually takes effect.",
        requestBody: jsonBody(refreshSchema, {
          example: { refreshToken: "8f14e45fceea467a9a5f1b8f1c2a3d4e…" },
        }),
        responses: {
          "200": successResponse("A fresh token pair.", { $ref: "#/components/schemas/AuthTokens" }),
          ...errorResponses("400", "401", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/logout`]: {
      post: {
        tags: ["Sessions"],
        operationId: "logout",
        security: [],
        summary: "End this session",
        description: "Revokes the refresh token in the body. Public for the same reason `refresh` is.",
        requestBody: jsonBody(logoutSchema, {
          example: { refreshToken: "8f14e45fceea467a9a5f1b8f1c2a3d4e…" },
        }),
        responses: {
          "204": noContentResponse,
          ...errorResponses("400", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/forgot-password`]: {
      post: {
        tags: ["Passwords"],
        operationId: "forgotPassword",
        security: [],
        summary: "Request a password reset code",
        description:
          "**Always `202`, same body, whether or not the account exists.** This is the most attractive enumeration target in the service, because it needs no credentials at all to probe.",
        requestBody: jsonBody(forgotPasswordSchema, { example: { email: "ada@example.com" } }),
        responses: {
          "202": successResponse(
            "Accepted. Says nothing about whether the address exists.",
            messageOnly("If that address has an account, a reset code is on its way."),
          ),
          ...errorResponses("400", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/reset-password`]: {
      post: {
        tags: ["Passwords"],
        operationId: "resetPassword",
        security: [],
        summary: "Set a new password with a reset code",
        description:
          "Consumes the code, writes the new hash and revokes every session in one transaction. Signing every device out is the point: if the reset was needed because someone else had the password, leaving their sessions alive would defeat it.",
        requestBody: jsonBody(resetPasswordSchema, {
          example: {
            email: "ada@example.com",
            code: "123456",
            password: "a new and unrelated passphrase",
          },
        }),
        responses: {
          "200": successResponse(
            "Password changed and all sessions revoked.",
            messageOnly("Password updated. All sessions have been signed out."),
          ),
          ...errorResponses("400", "401", "404", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/me`]: {
      get: {
        tags: ["Account"],
        operationId: "me",
        summary: "The signed-in account",
        description:
          "A valid token for an account that no longer exists is a 401, not a 404: the credential is the thing that is no longer good, and there is no resource to be missing.",
        ...authenticated,
        responses: {
          "200": successResponse("The caller's account.", { $ref: "#/components/schemas/AuthUser" }),
          ...errorResponses("401", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/change-password`]: {
      post: {
        tags: ["Passwords"],
        operationId: "changePassword",
        summary: "Change the password of the signed-in account",
        description:
          "Requires the current password — an access token is not enough, because a stolen one should not be able to lock the owner out. Every other session is revoked and a fresh pair is returned, so *this* device stays signed in and no other does.",
        ...authenticated,
        requestBody: jsonBody(changePasswordSchema, {
          example: {
            currentPassword: "correct horse battery staple",
            password: "a new and unrelated passphrase",
          },
        }),
        responses: {
          "200": successResponse(
            "Changed. The returned pair keeps this device signed in; every other session was revoked.",
            { $ref: "#/components/schemas/AuthTokens" },
          ),
          ...errorResponses("400", "401", "413", "422", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/sessions`]: {
      get: {
        tags: ["Account"],
        operationId: "listSessions",
        summary: "Live sessions",
        description: "Every unexpired, unrevoked refresh token for the caller. `current` marks this one.",
        ...authenticated,
        responses: {
          "200": successResponse("The caller's live sessions.", {
            type: "array",
            items: { $ref: "#/components/schemas/Session" },
          }),
          ...errorResponses("401", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/logout-all`]: {
      post: {
        tags: ["Sessions"],
        operationId: "logoutAll",
        summary: "Sign out everywhere",
        description: "Revokes every refresh token for the caller, this one included.",
        ...authenticated,
        responses: {
          "200": successResponse("How many sessions were cut.", {
            type: "object",
            required: ["revoked"],
            properties: { revoked: { type: "integer", minimum: 0 } },
          }),
          ...errorResponses("401", "429", "500", "503"),
        },
      },
    },

    [`${API_PREFIX}/auth/login-history`]: {
      get: {
        tags: ["Account"],
        operationId: "loginHistory",
        summary: "Recent login attempts",
        description: "The caller's own attempts, newest first. Filter by outcome or by success.",
        ...authenticated,
        parameters: parametersFrom(loginHistoryQuerySchema, "query"),
        responses: {
          "200": paginatedResponse("A page of attempts.", {
            $ref: "#/components/schemas/LoginHistoryEntry",
          }),
          ...errorResponses("401", "422", "429", "500", "503"),
        },
      },
    },
  },
};
