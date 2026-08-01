import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { logger } from "../lib/logger.js";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Assigns a correlation id to every request and exposes a request-scoped
 * logger. An inbound `x-request-id` (set by the gateway or a calling service)
 * is honoured so a single id spans the whole call chain.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const inbound = req.get(REQUEST_ID_HEADER);
  const requestId = inbound && inbound.length <= 200 ? inbound : randomUUID();

  req.id = requestId;
  req.log = logger.child({ requestId });
  req.validated = {};
  res.setHeader(REQUEST_ID_HEADER, requestId);

  next();
};
