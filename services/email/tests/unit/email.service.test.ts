import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../../src/errors/app-error.js";
import { EmailService } from "../../src/modules/email/email.service.js";
import type { SendEmailInput } from "../../src/modules/email/email.schema.js";
import { InMemoryEmailRepository } from "../helpers/in-memory-email-repository.js";
import { expectOk } from "../helpers/result.js";

const validInput: SendEmailInput = {
  recipient: "ada@example.com",
  subject: "Welcome",
  body: "Hello there",
  bodyType: "TEXT",
  source: "user-service",
};

describe("EmailService", () => {
  let repository: InMemoryEmailRepository;
  let service: EmailService;

  const seedWith = (
    messages = [] as ReturnType<typeof InMemoryEmailRepository.buildMessage>[],
  ): void => {
    repository = new InMemoryEmailRepository(messages);
    service = new EmailService(repository, { maxAttempts: 5 });
  };

  beforeEach(() => {
    seedWith();
  });

  describe("enqueue", () => {
    it("writes a PENDING row and reports it as newly created", async () => {
      const result = expectOk(await service.enqueue(validInput));
      expect(result.replayed).toBe(false);
      expect(result.message).toMatchObject({
        recipient: "ada@example.com",
        source: "user-service",
        status: "PENDING",
        attempts: 0,
      });
      expect(repository.size).toBe(1);
    });

    it("stamps the configured attempt ceiling onto the row", async () => {
      service = new EmailService(repository, { maxAttempts: 2 });

      const result = expectOk(await service.enqueue(validInput));

      // Copied at enqueue time, so raising the default later cannot revive
      // messages already declared dead under the old one.
      expect(result.message.maxAttempts).toBe(2);
    });

    it("replays the original message for a repeated idempotency key", async () => {
      const first = expectOk(await service.enqueue(validInput, "key-abc-123"));
      const second = expectOk(await service.enqueue(validInput, "key-abc-123"));
      expect(second.replayed).toBe(true);
      expect(second.message.id).toBe(first.message.id);
      // The whole point: the caller retried, and no second email exists.
      expect(repository.size).toBe(1);
    });

    it("ignores property order when matching a replayed payload", async () => {
      await service.enqueue(validInput, "key-abc-123");

      const reordered: SendEmailInput = {
        source: validInput.source,
        bodyType: validInput.bodyType,
        body: validInput.body,
        subject: validInput.subject,
        recipient: validInput.recipient,
      };

      const result = expectOk(await service.enqueue(reordered, "key-abc-123"));
      expect(result.replayed).toBe(true);
    });

    it("rejects a key reused for a different message", async () => {
      await service.enqueue(validInput, "key-abc-123");

      const [error] = await service.enqueue(
        { ...validInput, subject: "Something else" },
        "key-abc-123",
      );

      // Silently replaying here would drop the second email without telling
      // anyone, which is worse than refusing it.
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ statusCode: 409 });
      expect(repository.size).toBe(1);
    });

    it("creates separate messages when no key is supplied", async () => {
      await service.enqueue(validInput);
      await service.enqueue(validInput);

      expect(repository.size).toBe(2);
    });

    it("forwards a store failure rather than reporting success", async () => {
      repository.fail("enqueue");

      const [error, result] = await service.enqueue(validInput);

      expect(error).toMatchObject({ statusCode: 503 });
      expect(result).toBeNull();
    });
  });

  describe("getById", () => {
    it("returns a seeded message", async () => {
      const seeded = InMemoryEmailRepository.buildMessage();
      seedWith([seeded]);

      const message = expectOk(await service.getById(seeded.id));
      expect(message.id).toBe(seeded.id);
    });

    it("returns NotFoundError for an unknown id", async () => {
      const [error] = await service.getById("11111111-1111-4111-8111-111111111111");

      expect(error).toBeInstanceOf(NotFoundError);
    });

    it("distinguishes a store outage from a missing row", async () => {
      repository.fail("findById");

      const [error] = await service.getById("11111111-1111-4111-8111-111111111111");

      expect(error).not.toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ statusCode: 503 });
    });
  });

  describe("list", () => {
    it("echoes the requested page and limit alongside the total", async () => {
      seedWith([
        InMemoryEmailRepository.buildMessage({ source: "user-service" }),
        InMemoryEmailRepository.buildMessage({ source: "order-service" }),
      ]);

      const page = expectOk(await service.list({ page: 1, limit: 20 }));
      expect(page).toMatchObject({ total: 2, page: 1, limit: 20 });
      expect(page.items).toHaveLength(2);
    });

    it("filters by source", async () => {
      seedWith([
        InMemoryEmailRepository.buildMessage({ source: "user-service" }),
        InMemoryEmailRepository.buildMessage({ source: "order-service" }),
      ]);

      const page = expectOk(await service.list({ page: 1, limit: 20, source: "order-service" }));

      expect(page.total).toBe(1);
      expect(page.items[0]?.source).toBe("order-service");
    });
  });

  describe("stats", () => {
    it("reports every status, including the empty ones", async () => {
      seedWith([
        InMemoryEmailRepository.buildMessage({ status: "SENT" }),
        InMemoryEmailRepository.buildMessage({ status: "DEAD" }),
        InMemoryEmailRepository.buildMessage({ status: "DEAD" }),
      ]);

      const counts = expectOk(await service.stats());
      expect(counts).toEqual({ PENDING: 0, SENDING: 0, SENT: 1, FAILED: 0, DEAD: 2 });
    });
  });

  describe("retry", () => {
    it("returns a DEAD message to PENDING and clears its attempts", async () => {
      const dead = InMemoryEmailRepository.buildMessage({
        status: "DEAD",
        attempts: 5,
        lastError: "provider unavailable",
      });
      seedWith([dead]);

      const message = expectOk(await service.retry(dead.id));
      expect(message).toMatchObject({ status: "PENDING", attempts: 0 });
    });

    it("revives a FAILED message", async () => {
      const failed = InMemoryEmailRepository.buildMessage({ status: "FAILED", attempts: 2 });
      seedWith([failed]);

      const message = expectOk(await service.retry(failed.id));
      expect(message.status).toBe("PENDING");
    });

    it("refuses to resend an already delivered message", async () => {
      const sent = InMemoryEmailRepository.buildMessage({ status: "SENT" });
      seedWith([sent]);

      const [error] = await service.retry(sent.id);

      // The recipient already has this email; a retry would send a second copy.
      expect(error).toBeInstanceOf(ConflictError);
      expect(error?.message).toMatch(/SENT/);
    });

    it("refuses to disturb a message a dispatcher currently holds", async () => {
      const sending = InMemoryEmailRepository.buildMessage({
        status: "SENDING",
        lockedBy: "worker-1",
        lockedAt: new Date(),
      });
      seedWith([sending]);

      const [error] = await service.retry(sending.id);

      // Clearing the lock would hand it to a second worker mid-send.
      expect(error).toBeInstanceOf(ConflictError);
    });

    it("returns NotFoundError for an unknown id", async () => {
      const [error] = await service.retry("11111111-1111-4111-8111-111111111111");

      expect(error).toBeInstanceOf(NotFoundError);
    });
  });
});
