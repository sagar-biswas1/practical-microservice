import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmailDispatcher,
  type DispatcherOptions,
} from "../../src/modules/email/email.dispatcher.js";
import type { EmailMessage } from "../../src/modules/email/email.repository.js";
import { InMemoryEmailRepository } from "../helpers/in-memory-email-repository.js";
import { StubEmailProvider } from "../helpers/stub-email-provider.js";
import { expectOk } from "../helpers/result.js";

const NOW = new Date("2026-01-01T12:00:00.000Z");

function buildDispatcher(
  repository: InMemoryEmailRepository,
  provider: StubEmailProvider,
  overrides: Partial<DispatcherOptions> = {},
): EmailDispatcher {
  return new EmailDispatcher(repository, provider, {
    from: "noreply@example.com",
    batchSize: 25,
    concurrency: 5,
    pollIntervalMs: 1_000,
    claimTimeoutMs: 120_000,
    backoffBaseMs: 2_000,
    backoffMaxMs: 900_000,
    retentionDays: 30,
    now: () => NOW,
    // Deterministic jitter: exact retry times can then be asserted.
    random: () => 1,
    ...overrides,
  });
}

function pending(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return InMemoryEmailRepository.buildMessage({
    status: "PENDING",
    nextAttemptAt: new Date(NOW.getTime() - 1_000),
    ...overrides,
  });
}

describe("EmailDispatcher", () => {
  let repository: InMemoryEmailRepository;
  let provider: StubEmailProvider;

  beforeEach(() => {
    repository = new InMemoryEmailRepository();
    provider = new StubEmailProvider();
  });

  describe("successful delivery", () => {
    it("claims a due message, sends it, and records the receipt", async () => {
      const message = pending();
      repository = new InMemoryEmailRepository([message]);
      const dispatcher = buildDispatcher(repository, provider);

      const summary = expectOk(await dispatcher.runOnce());
      expect(summary).toEqual({ claimed: 1, sent: 1, retrying: 0, dead: 0 });
      expect(repository.get(message.id)).toMatchObject({
        status: "SENT",
        provider: "stub",
        providerMessageId: "stub-1",
        sentAt: NOW,
        attempts: 1,
        lockedAt: null,
        lockedBy: null,
      });
    });

    it("sends the row id as the provider-side idempotency key", async () => {
      const message = pending({ bodyType: "HTML", body: "<h1>Hi</h1>" });
      repository = new InMemoryEmailRepository([message]);

      await buildDispatcher(repository, provider).runOnce();

      // Delivery is at-least-once; this key is what stops a redelivery after
      // an ambiguous timeout from reaching the inbox twice.
      expect(provider.sent[0]).toEqual({
        id: message.id,
        from: "noreply@example.com",
        to: message.recipient,
        subject: message.subject,
        body: "<h1>Hi</h1>",
        bodyType: "HTML",
      });
    });

    it("leaves a message whose backoff has not expired alone", async () => {
      const notYetDue = pending({
        status: "FAILED",
        nextAttemptAt: new Date(NOW.getTime() + 60_000),
      });
      repository = new InMemoryEmailRepository([notYetDue]);

      const summary = expectOk(await buildDispatcher(repository, provider).runOnce());

      expect(summary.claimed).toBe(0);
      expect(provider.sent).toHaveLength(0);
    });

    it("claims no more than the batch size, oldest first", async () => {
      const older = pending({ nextAttemptAt: new Date(NOW.getTime() - 10_000) });
      const newer = pending({ nextAttemptAt: new Date(NOW.getTime() - 1_000) });
      repository = new InMemoryEmailRepository([newer, older]);

      const summary = expectOk(await buildDispatcher(repository, provider, {
        batchSize: 1,
      }).runOnce());

      expect(summary.claimed).toBe(1);
      expect(provider.sent[0]?.id).toBe(older.id);
    });
  });

  describe("retryable failures", () => {
    it("schedules a retry with exponential backoff and keeps the reason", async () => {
      const message = pending();
      repository = new InMemoryEmailRepository([message]);
      provider.always(StubEmailProvider.retryable("upstream 503"));

      const summary = expectOk(await buildDispatcher(repository, provider).runOnce());

      expect(summary).toEqual({ claimed: 1, sent: 0, retrying: 1, dead: 0 });
      expect(repository.get(message.id)).toMatchObject({
        status: "FAILED",
        attempts: 1,
        lastError: expect.stringContaining("upstream 503"),
        lockedAt: null,
        lockedBy: null,
      });
      // First attempt, jitter pinned to its maximum: base delay of 2s.
      expect(repository.get(message.id)?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 2_000));
    });

    it("backs off further with each failed attempt", async () => {
      const message = pending({ attempts: 2 });
      repository = new InMemoryEmailRepository([message]);
      provider.always(StubEmailProvider.retryable());

      await buildDispatcher(repository, provider).runOnce();

      // Claimed as attempt 3, so the delay is base * 2^2.
      expect(repository.get(message.id)?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 8_000));
    });

    it("dead-letters once the attempt ceiling is reached", async () => {
      const message = pending({ attempts: 4, maxAttempts: 5 });
      repository = new InMemoryEmailRepository([message]);
      provider.always(StubEmailProvider.retryable());

      const summary = expectOk(await buildDispatcher(repository, provider).runOnce());

      expect(summary).toEqual({ claimed: 1, sent: 0, retrying: 0, dead: 1 });
      expect(repository.get(message.id)).toMatchObject({ status: "DEAD", attempts: 5 });
    });

    it("recovers on a later attempt when the provider comes back", async () => {
      const message = pending();
      repository = new InMemoryEmailRepository([message]);
      provider.script(StubEmailProvider.retryable()).always("ok");
      const dispatcher = buildDispatcher(repository, provider);

      await dispatcher.runOnce();
      expect(repository.get(message.id)?.status).toBe("FAILED");

      // Second cycle, with the clock advanced past the backoff.
      const later = buildDispatcher(repository, provider, {
        now: () => new Date(NOW.getTime() + 60_000),
      });
      const summary = expectOk(await later.runOnce());

      expect(summary.sent).toBe(1);
      expect(repository.get(message.id)).toMatchObject({ status: "SENT", attempts: 2 });
    });

    it("treats a provider that throws as a transient failure", async () => {
      const message = pending();
      repository = new InMemoryEmailRepository([message]);
      // Breaking the error-first contract must not abort the batch.
      provider.always(new Error("client library blew up"));

      const summary = expectOk(await buildDispatcher(repository, provider).runOnce());
      expect(summary.retrying).toBe(1);
      expect(repository.get(message.id)?.lastError).toMatch(/Provider threw/);
    });
  });

  describe("permanent failures", () => {
    it("dead-letters immediately instead of spending the retry budget", async () => {
      const message = pending({ maxAttempts: 5 });
      repository = new InMemoryEmailRepository([message]);
      provider.always(StubEmailProvider.permanent("recipient does not exist"));

      const summary = expectOk(await buildDispatcher(repository, provider).runOnce());

      expect(summary).toEqual({ claimed: 1, sent: 0, retrying: 0, dead: 1 });
      expect(repository.get(message.id)).toMatchObject({
        status: "DEAD",
        // Four attempts still on the clock, and none of them would have
        // changed the answer.
        attempts: 1,
        lastError: expect.stringContaining("recipient does not exist"),
      });
    });

    it("does not claim a dead-lettered message again", async () => {
      const message = pending();
      repository = new InMemoryEmailRepository([message]);
      provider.always(StubEmailProvider.permanent());
      const dispatcher = buildDispatcher(repository, provider);

      await dispatcher.runOnce();
      const second = expectOk(await dispatcher.runOnce());

      expect(second.claimed).toBe(0);
      expect(provider.sent).toHaveLength(1);
    });
  });

  describe("claim exclusivity", () => {
    it("hands each message to exactly one worker", async () => {
      const messages = Array.from({ length: 5 }, () => pending());
      repository = new InMemoryEmailRepository(messages);

      const first = buildDispatcher(repository, provider, { workerId: "worker-a" });
      const second = buildDispatcher(repository, provider, { workerId: "worker-b" });

      const [resultA, resultB] = await Promise.all([first.runOnce(), second.runOnce()]);
      const summaryA = expectOk(resultA);
      const summaryB = expectOk(resultB);

      // The claim is a guarded state transition, so the second worker finds
      // the rows already SENDING and takes none of them.
      expect(summaryA.claimed + summaryB.claimed).toBe(5);
      expect(provider.sent).toHaveLength(5);
      expect(new Set(provider.sent.map((message) => message.id)).size).toBe(5);
    });

    it("reclaims a message whose worker died holding it", async () => {
      const orphan = InMemoryEmailRepository.buildMessage({
        status: "SENDING",
        attempts: 1,
        lockedBy: "worker-that-died",
        lockedAt: new Date(NOW.getTime() - 300_000),
      });
      repository = new InMemoryEmailRepository([orphan]);

      const summary = expectOk(await buildDispatcher(repository, provider, {
        claimTimeoutMs: 120_000,
      }).runOnce());

      expect(summary.sent).toBe(1);
      expect(repository.get(orphan.id)).toMatchObject({ status: "SENT", attempts: 2 });
    });

    it("leaves a live claim alone", async () => {
      const inFlight = InMemoryEmailRepository.buildMessage({
        status: "SENDING",
        lockedBy: "worker-busy",
        lockedAt: new Date(NOW.getTime() - 5_000),
      });
      repository = new InMemoryEmailRepository([inFlight]);

      const summary = expectOk(await buildDispatcher(repository, provider, {
        claimTimeoutMs: 120_000,
      }).runOnce());

      // Reclaiming here would send a message that is still in flight.
      expect(summary.claimed).toBe(0);
      expect(provider.sent).toHaveLength(0);
    });
  });

  describe("concurrency", () => {
    it("never exceeds the configured number of in-flight sends", async () => {
      let inFlight = 0;
      let peak = 0;

      provider = new StubEmailProvider(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      });

      repository = new InMemoryEmailRepository(Array.from({ length: 12 }, () => pending()));

      const summary = expectOk(await buildDispatcher(repository, provider, {
        concurrency: 3,
      }).runOnce());

      expect(summary.sent).toBe(12);
      // A batch of 12 must not become 12 simultaneous connections — that is
      // how a provider rate limit gets tripped.
      expect(peak).toBeLessThanOrEqual(3);
    });
  });

  describe("failure of the cycle itself", () => {
    it("returns the error rather than throwing when the store is unreachable", async () => {
      repository.fail("claimDue");

      const [error, summary] = await buildDispatcher(repository, provider).runOnce();

      expect(error).toMatchObject({ statusCode: 503 });
      expect(summary).toBeNull();
    });
  });

  describe("purge", () => {
    it("deletes delivered messages past the retention window", async () => {
      const old = InMemoryEmailRepository.buildMessage({
        status: "SENT",
        createdAt: new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000),
      });
      const recent = InMemoryEmailRepository.buildMessage({ status: "SENT", createdAt: NOW });
      const oldDead = InMemoryEmailRepository.buildMessage({
        status: "DEAD",
        createdAt: new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000),
      });
      repository = new InMemoryEmailRepository([old, recent, oldDead]);

      const deleted = expectOk(await buildDispatcher(repository, provider, {
        retentionDays: 30,
      }).purgeExpired());
      expect(deleted).toBe(1);
      expect(repository.get(old.id)).toBeUndefined();
      expect(repository.get(recent.id)).toBeDefined();
      // Dead letters are the record of what never arrived — never purged.
      expect(repository.get(oldDead.id)).toBeDefined();
    });

    it("does nothing when retention is disabled", async () => {
      const old = InMemoryEmailRepository.buildMessage({
        status: "SENT",
        createdAt: new Date(0),
      });
      repository = new InMemoryEmailRepository([old]);

      const deleted = expectOk(await buildDispatcher(repository, provider, {
        retentionDays: 0,
      }).purgeExpired());

      expect(deleted).toBe(0);
      expect(repository.size).toBe(1);
    });
  });

  describe("polling loop", () => {
    it("drains the outbox once started, and stops when told to", async () => {
      const message = pending();
      repository = new InMemoryEmailRepository([message]);
      const dispatcher = buildDispatcher(repository, provider, { pollIntervalMs: 5 });

      dispatcher.start();
      await vi.waitFor(() => expect(repository.get(message.id)?.status).toBe("SENT"));
      await dispatcher.stop();

      const sendsAtStop = provider.sent.length;
      repository = new InMemoryEmailRepository([pending()]);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(provider.sent).toHaveLength(sendsAtStop);
    });
  });
});
