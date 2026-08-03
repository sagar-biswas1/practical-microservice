import morgan from "morgan";
import type { Request, RequestHandler, Response } from "express";
import { isTest } from "../config/env.js";
import { logger } from "../lib/logger.js";

morgan.token("id", (req) => (req as Request).id);

/**
 * Morgan produces one JSON line per completed request; the stream hands it to
 * pino so access logs land in the same structured sink as everything else.
 */
const format: morgan.FormatFn<Request, Response> = (tokens, req, res) =>
  JSON.stringify({
    requestId: tokens["id"]?.(req, res),
    method: tokens["method"]?.(req, res),
    url: tokens["url"]?.(req, res),
    status: Number(tokens["status"]?.(req, res) ?? 0),
    contentLength: Number(tokens["res"]?.(req, res, "content-length") ?? 0),
    durationMs: Number(tokens["response-time"]?.(req, res) ?? 0),
    ip: tokens["remote-addr"]?.(req, res),
    userAgent: tokens["user-agent"]?.(req, res),
  });

export const requestLogger: RequestHandler = morgan<Request, Response>(format, {
  skip: () => isTest,
  stream: {
    write: (line: string) => {
      try {
        const entry = JSON.parse(line) as { status: number };
        if (entry.status >= 500) logger.error(entry, "http_request");
        else if (entry.status >= 400) logger.warn(entry, "http_request");
        else logger.info(entry, "http_request");
      } catch {
        logger.info(line.trim());
      }
    },
  },
});
