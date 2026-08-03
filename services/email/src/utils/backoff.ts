export interface BackoffOptions {
  /** Delay after the first failed attempt, before jitter. */
  baseMs: number;
  /** Ceiling on the pre-jitter delay, so growth stops being exponential. */
  maxMs: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Exponential backoff with jitter: 2s, 4s, 8s, 16s … capped, then spread.
 *
 * The doubling is the obvious half. The jitter is the half that matters in a
 * distributed system: without it, every message that failed during the same
 * provider outage carries the same `nextAttemptAt`, and when the backoff
 * expires all of them are claimed in the same cycle and hit the provider in
 * the same instant. That thundering herd is often enough to knock over a
 * service that had just recovered, which restarts the whole cycle.
 *
 * This uses *equal jitter* — half the delay fixed, half random — rather than
 * full jitter. Keeping a floor matters here because the floor is what actually
 * gives a struggling provider room to recover; full jitter can schedule a
 * retry almost immediately after a failure.
 */
export function backoffDelayMs(
  attempts: number,
  { baseMs, maxMs, random = Math.random }: BackoffOptions,
): number {
  const exponent = Math.max(0, attempts - 1);
  // Bound the exponent before the shift: `2 ** 1024` is Infinity, and
  // Infinity * baseMs would defeat the `Math.min` below on a row that somehow
  // accumulated a large attempt count.
  const uncapped = baseMs * 2 ** Math.min(exponent, 30);
  const capped = Math.min(maxMs, uncapped);
  const half = capped / 2;

  return Math.round(half + random() * half);
}

/** The wall-clock time a failed attempt becomes eligible again. */
export function nextAttemptAt(
  attempts: number,
  options: BackoffOptions & { now?: Date },
): Date {
  const now = options.now ?? new Date();
  return new Date(now.getTime() + backoffDelayMs(attempts, options));
}
