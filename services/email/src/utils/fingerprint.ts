import { createHash } from "node:crypto";

/**
 * Stable SHA-256 of a request payload, stored alongside an idempotency key.
 *
 * Keys are sorted before hashing so that two JSON bodies differing only in
 * property order produce the same digest — otherwise a client library that
 * serialises fields in a different order on the retry would look like a
 * different request and be rejected.
 */
export function fingerprint(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(payload)
      .sort()
      .map((key) => [key, payload[key]]),
  );

  return createHash("sha256").update(canonical).digest("hex");
}
