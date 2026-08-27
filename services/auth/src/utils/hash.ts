import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Fast hashing for high-entropy secrets — refresh tokens and verification
 * codes. Passwords do not belong here; they go through `lib/password.ts`.
 *
 * The distinction is entropy, not importance. A 256-bit random token cannot be
 * brute-forced no matter how fast the hash is, so a slow one buys nothing and
 * would put an argon2 computation on every refresh request. A human-chosen
 * password has perhaps 30 bits of real entropy and must be defended by making
 * each guess expensive. Same operation, opposite requirements.
 */

/** SHA-256 as lowercase hex — 64 characters, matching the VarChar(64) columns. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * A URL-safe random string with `bytes * 8` bits of entropy.
 *
 * `randomBytes` is the CSPRNG; `Math.random` is not, and using it here would
 * make tokens predictable from one another.
 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `===` on strings short-circuits at the first differing character, so the
 * time it takes leaks how much of a guess was correct. That is enough to
 * recover a secret one character at a time given enough samples. The lengths
 * are checked first because `timingSafeEqual` throws on a mismatch — and a
 * length difference is not a secret worth protecting, since every digest here
 * is the same width by construction.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
