import { randomInt } from "node:crypto";
import { sha256 } from "./hash.js";

/**
 * Six-digit verification codes.
 *
 * Six digits is a million possibilities — trivially brute-forceable if nothing
 * else stood in the way, which is why the code is never the only control. It
 * is bounded by three things at once, and all three are load-bearing:
 *
 *   1. a short expiry (`VERIFICATION_CODE_TTL_MINUTES`),
 *   2. an attempt ceiling that burns the code after a handful of wrong tries,
 *   3. a resend cooldown, so an attacker cannot mint fresh chances at will.
 *
 * Remove any one and the other two stop being sufficient. A code with no
 * attempt limit falls in seconds; one with no expiry gives an attacker
 * unlimited round-trips; one with no cooldown lets them replace a burned code
 * as fast as they can exhaust it.
 */

export const CODE_LENGTH = 6;

/**
 * Generates a zero-padded six-digit code.
 *
 * `randomInt` is the CSPRNG and is free of modulo bias — `Math.random()` is
 * neither, and a predictable verification code is the same bug as a
 * predictable password reset link.
 *
 * Padding rather than starting at 100000 keeps the full 10^6 space: excluding
 * codes with a leading zero would throw away a tenth of it for cosmetics.
 */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, "0");
}

/**
 * Hashes a code for storage. Same function on the way in and on the way out,
 * so verification is a hash-and-compare and the plaintext code exists only in
 * the email that carried it.
 */
export function hashCode(code: string): string {
  return sha256(code);
}
