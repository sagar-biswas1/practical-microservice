import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { logger } from "../lib/logger.js";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Identifies the caller behind the request, set by the gateway after it
 * authenticates them. Forwarded verbatim on downstream calls so the inventory
 * service can attribute the changes this service makes on the caller's behalf.
 */
export const ACTOR_HEADER = "x-actor-id";

/** Matches the actor column downstream; longer values are truncated. */
const ACTOR_MAX_LENGTH = 120;

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

  const actor = req.get(ACTOR_HEADER)?.trim();
  if (actor) req.actor = actor.slice(0, ACTOR_MAX_LENGTH);

  res.setHeader(REQUEST_ID_HEADER, requestId);

  next();
};
