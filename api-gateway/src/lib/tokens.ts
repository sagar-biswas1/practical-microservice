import { jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env.js";

/**
 * Access-token verification, mirrored from the auth service.
 *
 * Mirrored rather than imported: sharing code here would mean the gateway
 * depends on the auth service's package, and an edge that cannot start
 * without the thing it fronts is a worse trade than fifty duplicated lines.
 * What actually has to stay in sync is the *contract* — algorithm, issuer,
 * audience, claim names — and that is small, versioned by the secret, and
 * checked by the integration tests.
 *
 * Only the access token is understood here. The refresh token is an opaque
 * string whose meaning lives in the auth service's database; the gateway has
 * no way to interpret it and no business trying.
 */

/** The claims the auth service puts in an access token. */
export interface AccessTokenClaims {
  /** `sub` — the auth user id. */
  sub: string;
  email: string;
  username: string;
  /** `USER` or `ADMIN`, matching the auth service's `Role` enum. */
  role: string;
  /** The refresh-token family this access token was minted under. */
  sid: string;
}

const ALGORITHM = "HS256";

/** Derived once: the secret is frozen at boot, and deriving it is measurable. */
const secretKey = new TextEncoder().encode(env.JWT_SECRET);

/** Pulls the token out of `Authorization: Bearer <token>`, case-insensitively. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;

  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (rest.length > 0 || scheme?.toLowerCase() !== "bearer" || !token) return null;

  return token;
}

/**
 * Verifies an access token and returns its claims, or `null` if it is not
 * usable for any reason.
 *
 * `algorithms` is pinned rather than read from the token header. A verifier
 * that honours the token's own `alg` will accept `alg: none` — the algorithm
 * is the verifier's decision, never the token's.
 *
 * Every failure collapses to `null`: expired, wrong signature, wrong issuer
 * and malformed are one outcome to the caller, because telling them apart
 * tells an attacker which part of a forgery to fix next.
 *
 * Never rejects, so callers can treat it as total.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secretKey, {
      algorithms: [ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }));
  } catch {
    return null;
  }

  // jose guarantees the registered claims it was asked to check; the custom
  // ones are still `unknown`, and a token minted by an older build of the auth
  // service might genuinely lack them.
  const { sub, email, username, role, sid } = payload;
  if (
    typeof sub !== "string" ||
    typeof email !== "string" ||
    typeof username !== "string" ||
    typeof role !== "string" ||
    typeof sid !== "string"
  ) {
    return null;
  }

  return { sub, email, username, role, sid };
}
