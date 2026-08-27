import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env.js";
import { InternalServerError, UnauthorizedError } from "../errors/app-error.js";
import { ok, type Result } from "../utils/result.js";
import { randomToken, sha256 } from "../utils/hash.js";

/**
 * Token minting and verification.
 *
 * The two token types here are deliberately different *kinds* of thing, and
 * the asymmetry is the design rather than an inconsistency:
 *
 * - The **access token** is a signed JWT. Verifying it is pure computation —
 *   no database, no network — which is what lets every other service check it
 *   on every request. The price is that it cannot be revoked, so it is given a
 *   short life and no authority beyond it.
 *
 * - The **refresh token** is an opaque random string with no structure and no
 *   signature. It carries no claims because it asserts nothing; it is merely a
 *   lookup key into `refresh_tokens`, where the real state lives. That is
 *   precisely what makes it revocable — and revocation is the entire reason
 *   the long-lived credential is this one and not a JWT.
 */

/** Claims this service puts in an access token, beyond the registered ones. */
export interface AccessTokenClaims {
  /** `sub` — the auth user id. */
  sub: string;
  email: string;
  username: string;
  role: string;
  /** The refresh-token family this access token was minted under. */
  sid: string;
}

export interface AccessToken {
  token: string;
  /** Seconds until expiry, for the client to schedule its refresh. */
  expiresIn: number;
  expiresAt: Date;
}

export interface RefreshTokenValue {
  /** Returned to the client once and never stored. */
  token: string;
  /** What goes in the database. */
  tokenHash: string;
  expiresAt: Date;
}

const ALGORITHM = "HS256";

/**
 * Cached because deriving it on every request is measurable, and because the
 * secret cannot change without a restart anyway — `env` is frozen at boot.
 */
const secretKey = new TextEncoder().encode(env.JWT_SECRET);

const accessTokenTtlSeconds = env.ACCESS_TOKEN_TTL_MINUTES * 60;
const refreshTokenTtlMs = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Signs an access token. `now` is injectable so tests need no fake clock. */
export async function signAccessToken(
  claims: AccessTokenClaims,
  now: Date = new Date(),
): Promise<Result<AccessToken>> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAtSeconds = issuedAt + accessTokenTtlSeconds;

  try {
    const token = await new SignJWT({
      email: claims.email,
      username: claims.username,
      role: claims.role,
      sid: claims.sid,
    })
      .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
      .setSubject(claims.sub)
      .setIssuer(env.JWT_ISSUER)
      .setAudience(env.JWT_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAtSeconds)
      .sign(secretKey);

    return ok({
      token,
      expiresIn: accessTokenTtlSeconds,
      expiresAt: new Date(expiresAtSeconds * 1000),
    });
  } catch (error) {
    // Signing does not fail for input reasons — the claims are ours and the
    // key was validated at boot — so anything here is a broken runtime, not a
    // bad request.
    return [new InternalServerError("Access token could not be issued", error), null];
  }
}

/**
 * Verifies an access token and returns its claims.
 *
 * `algorithms` is pinned to a single value. Leaving it open is the classic JWT
 * vulnerability: a library that honours the token's own `alg` header will
 * happily accept `alg: none`, or verify an RS256 token using the public key as
 * an HMAC secret. The safe rule is that the *verifier* decides the algorithm,
 * never the token.
 *
 * Every failure — expired, wrong signature, wrong issuer, malformed — comes
 * back as the same 401 with the same message. Distinguishing them for the
 * client would tell an attacker which part of a forgery to fix next.
 */
export async function verifyAccessToken(token: string): Promise<Result<AccessTokenClaims>> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, secretKey, {
      algorithms: [ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }));
  } catch {
    return [new UnauthorizedError("Access token is invalid or has expired"), null];
  }

  // jose guarantees the registered claims it was asked to check; the custom
  // ones are still `unknown` and a token signed by an older version of this
  // service might genuinely lack them.
  const { sub, email, username, role, sid } = payload;
  if (
    typeof sub !== "string" ||
    typeof email !== "string" ||
    typeof username !== "string" ||
    typeof role !== "string" ||
    typeof sid !== "string"
  ) {
    return [new UnauthorizedError("Access token is missing required claims"), null];
  }

  return ok({ sub, email, username, role, sid });
}

/**
 * Mints a refresh token: the value to hand back, and the hash to store.
 *
 * 32 random bytes — the same 256 bits the access token's signature rests on.
 * Only the hash is persisted, so a dump of `refresh_tokens` yields nothing an
 * attacker can present: they would need a preimage of SHA-256.
 */
export function createRefreshToken(now: Date = new Date()): RefreshTokenValue {
  const token = randomToken(32);
  return {
    token,
    tokenHash: sha256(token),
    expiresAt: new Date(now.getTime() + refreshTokenTtlMs),
  };
}

/** Hashes a token presented by a client, for lookup against the stored hash. */
export function hashRefreshToken(token: string): string {
  return sha256(token);
}

/**
 * Pulls a bearer token out of an `Authorization` header.
 *
 * Returns undefined rather than an error for anything unparseable; deciding
 * whether a missing token is a 401 or an anonymous request belongs to the
 * caller, not to a string function.
 */
export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value, ...rest] = header.trim().split(/\s+/);
  if (rest.length > 0) return undefined;
  if (!scheme || scheme.toLowerCase() !== "bearer") return undefined;
  return value && value.length > 0 ? value : undefined;
}
