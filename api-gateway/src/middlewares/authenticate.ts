import type { RequestHandler } from "express";
import { ForbiddenError, UnauthorizedError } from "../errors/app-error.js";
import { extractBearerToken, verifyAccessToken } from "../lib/tokens.js";
import { ACTOR_HEADER } from "./request-context.js";

/** Roles the auth service can stamp into a token. */
export const Role = {
  USER: "USER",
  ADMIN: "ADMIN",
} as const;

export type RoleValue = (typeof Role)[keyof typeof Role];

/**
 * Requires a valid access token, puts the caller on `req.auth`, and stamps the
 * verified identity into the headers that get proxied.
 *
 * This is the point of doing it here rather than only downstream. The gateway
 * is the one hop that talks to untrusted clients, so it is the only hop that
 * can tell a proven identity from a claimed one — and `x-actor-id`, which the
 * services attribute audited writes to, is set from the token's `sub` and
 * nowhere else. `requestContext` has already deleted whatever the client sent
 * under that name, so the write below cannot be a client's value surviving.
 *
 * Rejecting at the edge is not a substitute for the services' own checks, and
 * is not meant to be: each service still verifies the same token. What the
 * edge buys is that an unauthenticated request never reaches an upstream at
 * all, and that a 401 looks the same whichever service would have served it.
 *
 * Verification is pure computation — signature, issuer, audience, expiry — so
 * this costs microseconds and makes no call to the auth service. The price is
 * that it cannot see a revocation: an account suspended a moment ago still
 * passes until its token expires. That window is the access-token TTL, which
 * is why that value is small.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  const token = extractBearerToken(req.get("authorization"));
  if (!token) {
    next(new UnauthorizedError("A bearer access token is required"));
    return;
  }

  // `verifyAccessToken` never rejects, so there is no error branch to handle.
  void verifyAccessToken(token).then((claims) => {
    if (!claims) {
      next(new UnauthorizedError("Access token is invalid or has expired"));
      return;
    }

    req.auth = {
      authUserId: claims.sub,
      email: claims.email,
      username: claims.username,
      role: claims.role,
      sessionId: claims.sid,
    };

    // Rewritten, not merely recorded: `req.headers` is what the proxy forwards,
    // so this is what the upstream actually receives.
    req.actor = claims.sub;
    req.headers[ACTOR_HEADER] = claims.sub;

    next();
  });
};

/**
 * Requires one of the listed roles. Must be declared after `authenticate` in
 * a policy's handler chain — a request arriving here without `req.auth` is a
 * wiring mistake, and it is reported as a 401 rather than waved through.
 *
 * The role comes from the token, so a demotion does not take effect until the
 * caller's next refresh. Same window, same reason, as the revocation note
 * above; a service that cannot tolerate that window has to re-check against
 * its own data, which is exactly what the services still do.
 */
export function requireRole(...roles: readonly RoleValue[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }

    if (!roles.includes(req.auth.role as RoleValue)) {
      next(new ForbiddenError("Insufficient permissions"));
      return;
    }

    next();
  };
}
