import { pino } from "pino";
import type { Logger, LoggerOptions } from "pino";
import { env, isDevelopment, isTest } from "../config/env.js";

const options: LoggerOptions = {
  level: isTest ? "silent" : env.LOG_LEVEL,
  base: {
    service: env.SERVICE_NAME,
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Keep credentials and tokens out of the log stream.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "*.password",
      "*.token",
      "*.secret",
      "DATABASE_URL",
    ],
    censor: "[redacted]",
  },
};

export const logger: Logger = isDevelopment
  ? pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname,service,env",
        },
      },
    })
  : pino(options);

export type { Logger };
