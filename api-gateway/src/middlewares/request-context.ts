import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Identifies the authenticated caller. Downstream services attribute audited
 * writes to whatever arrives in this header, which is exactly why the gateway
 * — the only hop that talks to untrusted clients — decides its value.
 */
export const ACTOR_HEADER = "x-actor-id";

/** Matches the actor column downstream; longer values are truncated. */
const ACTOR_MAX_LENGTH = 120;

/**
 * Assigns a correlation id to every request and exposes a request-scoped
 * logger.
 *
 * The gateway is the origin of the correlation id for public traffic, but an
 * inbound `x-request-id` is still honoured so that a trace started by an
 * upstream caller (a load balancer, or an internal service reaching in through
 * the edge) spans the whole call chain rather than restarting here.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const inbound = req.get(REQUEST_ID_HEADER);
  const requestId = inbound && inbound.length <= 200 ? inbound : randomUUID();

  req.id = requestId;
  req.log = logger.child({ requestId });

  // Rewritten rather than merely read: `req.headers` is what gets proxied, so
  // normalising it here is what the upstream actually receives.
  req.headers[REQUEST_ID_HEADER] = requestId;

  const claimed = req.get(ACTOR_HEADER)?.trim();
  if (env.TRUST_CLIENT_ACTOR && claimed) {
    req.actor = claimed.slice(0, ACTOR_MAX_LENGTH);
    req.headers[ACTOR_HEADER] = req.actor;
  } else {
    // No authentication at this edge yet, so any client-supplied actor is an
    // unverified claim. Dropping it keeps forged identities out of downstream
    // audit logs; an authenticated actor gets set here once auth lands.
    delete req.headers[ACTOR_HEADER];
  }

  res.setHeader(REQUEST_ID_HEADER, requestId);

  next();
};
