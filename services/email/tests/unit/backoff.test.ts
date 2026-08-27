import { describe, expect, it } from "vitest";
import { backoffDelayMs, nextAttemptAt } from "../../src/utils/backoff.js";

const OPTIONS = { baseMs: 2_000, maxMs: 900_000 };

describe("backoffDelayMs", () => {
  it("doubles the delay on each successive attempt", () => {
    // random() === 1 removes the jitter, exposing the underlying schedule.
    const delays = [1, 2, 3, 4].map((attempts) =>
      backoffDelayMs(attempts, { ...OPTIONS, random: () => 1 }),
    );

    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it("keeps the delay within [half, full] of the exponential value", () => {
    const floor = backoffDelayMs(3, { ...OPTIONS, random: () => 0 });
    const ceiling = backoffDelayMs(3, { ...OPTIONS, random: () => 1 });

    expect(floor).toBe(4_000);
    expect(ceiling).toBe(8_000);
  });

  it("spreads retries so a recovering provider is not hit in lockstep", () => {
    const delays = new Set(
      Array.from({ length: 50 }, () => backoffDelayMs(4, OPTIONS)),
    );

    // The whole point of jitter: 50 messages that failed together must not
    // come back at the same instant.
    expect(delays.size).toBeGreaterThan(10);
  });

  it("caps at maxMs however many attempts have been made", () => {
    expect(backoffDelayMs(20, { ...OPTIONS, random: () => 1 })).toBe(900_000);
  });

  it("does not overflow to Infinity on an absurd attempt count", () => {
    const delay = backoffDelayMs(5_000, { ...OPTIONS, random: () => 1 });

    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(900_000);
  });

  it("treats a zeroth attempt as the base delay", () => {
    expect(backoffDelayMs(0, { ...OPTIONS, random: () => 1 })).toBe(2_000);
  });
});

describe("nextAttemptAt", () => {
  it("returns a time in the future relative to the supplied clock", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    const at = nextAttemptAt(2, { ...OPTIONS, random: () => 1, now });

    expect(at.toISOString()).toBe("2026-01-01T00:00:04.000Z");
  });
});
