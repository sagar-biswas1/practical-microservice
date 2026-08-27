import argon2 from "argon2";
import { env } from "../config/env.js";
import { InternalServerError } from "../errors/app-error.js";
import { attempt, ok, type Result } from "../utils/result.js";

/**
 * Password hashing. The only module in the service that touches a plaintext
 * password, and it never returns one.
 *
 * Argon2id, not bcrypt or a plain SHA: a password hash is supposed to be slow
 * and memory-hungry so that an attacker holding a stolen `auth_users` table
 * cannot test billions of candidates per second on a GPU. Argon2id is the
 * current OWASP first choice because the memory cost is what defeats GPUs —
 * they have thousands of cores but very little memory per core.
 *
 * The cost parameters are encoded inside every digest argon2 produces, so
 * raising them later needs no migration and no re-hash: existing passwords
 * keep verifying under the settings they were created with, and each one is
 * upgraded the next time its owner changes it.
 */

const options = {
  type: argon2.argon2id,
  memoryCost: env.ARGON2_MEMORY_COST_KIB,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
} as const;

/** Hashes a plaintext password. The salt is generated per call by argon2. */
export function hashPassword(plaintext: string): Promise<Result<string>> {
  return attempt(() => argon2.hash(plaintext, options));
}

/**
 * Checks a password against a stored digest.
 *
 * A mismatch is `[null, false]`, not an error: a wrong password is an ordinary
 * answer to the question, and only the service layer knows whether it means
 * "401" or "the confirmation you typed does not match". A *thrown* argon2
 * error is different — it means the stored digest is malformed or the native
 * binding is broken — and that becomes `[error, null]` so it can never be
 * mistaken for a failed comparison.
 *
 * That distinction is the reason this is not a plain `Promise<boolean>`. If
 * both cases collapsed into `false`, a corrupted hash column would present
 * itself as "everyone suddenly has the wrong password" — and would be logged
 * as a wave of failed logins rather than as the outage it is.
 */
export async function verifyPassword(
  digest: string,
  plaintext: string,
): Promise<Result<boolean>> {
  // No options passed, and that is not an oversight: argon2 reads the salt and
  // every cost parameter out of the encoded digest. Handing it the *current*
  // settings would silently break verification for every password hashed
  // before the last time those settings changed.
  const [error, matched] = await attempt(() => argon2.verify(digest, plaintext));
  if (error) {
    return [new InternalServerError("Stored password hash could not be verified", error), null];
  }
  return ok(matched);
}
