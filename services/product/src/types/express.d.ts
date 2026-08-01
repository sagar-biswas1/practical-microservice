import type { Logger } from "pino";

declare global {
  namespace Express {
    interface Request {
      /** Correlation id — from the inbound `x-request-id` header or generated. */
      id: string;
      /** Request-scoped child logger, pre-tagged with the correlation id. */
      log: Logger;
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
