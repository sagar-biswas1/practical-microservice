import type { RequestHandler } from "express";
import { ForbiddenError, UnauthorizedError } from "../errors/app-error.js";
import { extractBearerToken, verifyAccessToken } from "../lib/tokens.js";

/**
 * Requires a valid access token and puts the caller on `req.auth`.
 *
 * Verification is pure computation — signature, issuer, audience, expiry — and
 * touches no database. That is the whole point of a signed access token: this
 * middleware costs microseconds and can be copied into any other service in
 * the repo without giving it a connection to the auth database.
 *
 * The cost of that is real and worth stating plainly: **this check cannot see
 * a revocation.** An account suspended thirty seconds ago still passes here
 * until its token expires. That window is exactly `ACCESS_TOKEN_TTL_MINUTES`,
 * which is why the value is small and why status is re-checked on every
 * refresh, where a database is already in hand.
 *
 * Like `validate`, this is the one layer that still signals failure with
 * `next(error)` rather than an error-first tuple: it is Express middleware,
 * and the framework's contract is the error channel.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  const token = extractBearerToken(req.get("authorization"));
  if (!token) {
    next(new UnauthorizedError("A bearer access token is required"));
    return;
  }

  void verifyAccessToken(token).then(([error, claims]) => {
    if (error) return next(error);

    req.auth = {
      authUserId: claims.sub,
      email: claims.email,
      username: claims.username,
      role: claims.role,
      sessionId: claims.sid,
    };
    // Attribute writes in this service's own logs, and in any downstream call
    // made on the caller's behalf, to the authenticated principal.
    req.actor = claims.sub;
    next();
  });
};

/**
 * Requires one of the listed roles. Must be mounted *after* `authenticate` —
 * an unauthenticated request reaching here is a wiring mistake, so it is
 * reported as a 401 rather than silently treated as anonymous.
 *
 * The role comes from the token, which means a role change does not take
 * effect until the next refresh. Same window, same reason, as above.
 */
export function requireRole(...roles: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(new UnauthorizedError("Authentication required"));
      return;
    }

    if (!roles.includes(req.auth.role)) {
      next(new ForbiddenError("Insufficient permissions"));
      return;
    }

    next();
  };
}
