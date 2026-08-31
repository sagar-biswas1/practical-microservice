import type { Logger } from "pino";

/** The verified caller, as read off a valid access token. */
export interface AuthContext {
  /** The auth service's user id — the token's `sub`. */
  authUserId: string;
  email: string;
  username: string;
  /** `USER` or `ADMIN`. */
  role: string;
  /** The refresh-token family the access token was minted under. */
  sessionId: string;
}

declare global {
  namespace Express {
    interface Request {
      /** Correlation id — from the inbound `x-request-id` header or generated. */
      id: string;
      /** Request-scoped child logger, pre-tagged with the correlation id. */
      log: Logger;
      /**
       * Caller identity forwarded downstream as `x-actor-id`. Only ever set
       * from a source the gateway trusts — see `requestContext`.
       */
      actor?: string;
      /**
       * Set by `authenticate`, and only on routes a policy protects. Its
       * absence means the route is public, not that the caller is anonymous —
       * a public route never looks at the token even when one is present.
       */
      auth?: AuthContext;
    }
  }
}

export {};
