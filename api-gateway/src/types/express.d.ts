import type { Logger } from "pino";

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
    }
  }
}

export {};
