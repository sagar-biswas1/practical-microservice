import { SignJWT } from "jose";
import { env } from "../../src/config/env.js";

export interface TokenOptions {
  sub?: string;
  role?: "USER" | "ADMIN";
  /** Seconds from now. Negative values produce an already-expired token. */
  expiresInSeconds?: number;
  /** Sign with something other than the configured secret, to forge a token. */
  secret?: string;
  issuer?: string;
}

const key = (secret: string): Uint8Array => new TextEncoder().encode(secret);

/**
 * Mints an access token the way the auth service would.
 *
 * Signed for real rather than stubbed: the whole point of edge verification is
 * that it is the same computation the auth service does, and a mocked verifier
 * would prove nothing about whether the two agree.
 */
export async function signTestToken({
  sub = "auth-user-1",
  role = "USER",
  expiresInSeconds = 900,
  secret = env.JWT_SECRET,
  issuer = env.JWT_ISSUER,
}: TokenOptions = {}): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);

  return new SignJWT({
    email: `${sub}@example.com`,
    username: sub,
    role,
    sid: "session-1",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresInSeconds)
    .sign(key(secret));
}

/** `Authorization` header value for a freshly minted token. */
export async function bearer(options: TokenOptions = {}): Promise<string> {
  return `Bearer ${await signTestToken(options)}`;
}
