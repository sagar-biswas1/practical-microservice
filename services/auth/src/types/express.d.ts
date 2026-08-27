import type { Logger } from "pino";

/** The verified caller, as decoded from the access token by `authenticate`. */
export interface AuthPrincipal {
  /** `auth_users.id` — the token's `sub` claim. */
  authUserId: string;
  email: string;
  username: string;
  role: string;
  /** The refresh-token family this access token was minted under (`sid`). */
  sessionId: string;
}

declare global {
  namespace Express {
    interface Request {
      /** Correlation id — from the inbound `x-request-id` header or generated. */
      id: string;
      /** Request-scoped child logger, pre-tagged with the correlation id. */
      log: Logger;
      /** Authenticated caller from `x-actor-id`; absent when unattributed. */
      actor?: string;
      /**
       * Set by the `authenticate` middleware. Optional because public routes
       * exist — and because TypeScript cannot know which middleware ran, so
       * every handler behind `authenticate` still has to narrow it.
       */
      auth?: AuthPrincipal;
      /** Payloads that passed Zod validation. Populated by the `validate` middleware. */
      validated: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
