import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { API_PREFIX } from "../../src/routes/index.js";
import { EmailDispatcher } from "../../src/modules/email/email.dispatcher.js";
import { EmailService } from "../../src/modules/email/email.service.js";
import { InMemoryEmailRepository } from "../helpers/in-memory-email-repository.js";
import { StubEmailProvider } from "../helpers/stub-email-provider.js";

const BASE = `${API_PREFIX}/emails`;
const UNKNOWN_ID = "1c9e6679-7425-40de-944b-e07fc1f90ae7";

const validPayload = {
  recipient: "Ada@Example.com",
  subject: "Welcome aboard",
  body: "Hello there",
  source: "user-service",
};

interface Harness {
  app: Express;
  repository: InMemoryEmailRepository;
  provider: StubEmailProvider;
  dispatcher: EmailDispatcher;
}

function buildHarness(repository = new InMemoryEmailRepository()): Harness {
  const provider = new StubEmailProvider();
  const dispatcher = new EmailDispatcher(repository, provider, {
    from: "noreply@example.com",
    batchSize: 25,
    concurrency: 5,
    pollIntervalMs: 60_000,
    claimTimeoutMs: 120_000,
    backoffBaseMs: 2_000,
    backoffMaxMs: 900_000,
    retentionDays: 0,
  });

  const app = createApp({
    emailService: new EmailService(repository, { maxAttempts: 5 }),
    dispatcher,
  });

  return { app, repository, provider, dispatcher };
}

describe("emails API", () => {
  let harness: Harness;
  let app: Express;

  beforeEach(() => {
    harness = buildHarness();
    app = harness.app;
  });

  describe("POST /emails", () => {
    it("accepts a message into the outbox and answers 202", async () => {
      const response = await request(app).post(BASE).send(validPayload).expect(202);

      expect(response.body).toMatchObject({
        success: true,
        data: {
          // Normalised, as the user service does with its email column.
          recipient: "ada@example.com",
          source: "user-service",
          // 202 rather than 201: the row is committed, the email is not sent.
          status: "PENDING",
          bodyType: "TEXT",
          attempts: 0,
        },
      });
      expect(response.body.data.id).toBeTruthy();
      expect(harness.repository.size).toBe(1);
      // Nothing reached the provider inside the request.
      expect(harness.provider.sent).toHaveLength(0);
    });

    it("defaults the body type to TEXT and accepts HTML explicitly", async () => {
      const response = await request(app)
        .post(BASE)
        .send({ ...validPayload, bodyType: "HTML", body: "<h1>Hi</h1>" })
        .expect(202);

      expect(response.body.data.bodyType).toBe("HTML");
    });

    it("returns 422 with per-field details for invalid input", async () => {
      const response = await request(app)
        .post(BASE)
        .send({ recipient: "not-an-email", subject: "", body: "", source: "" })
        .expect(422);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");

      const fields = response.body.error.details.map((detail: { field: string }) => detail.field);
      expect(fields).toEqual(
        expect.arrayContaining(["recipient", "subject", "body", "source"]),
      );
    });

    it("rejects unknown fields rather than silently dropping them", async () => {
      const response = await request(app)
        .post(BASE)
        .send({ ...validPayload, cc: "someone@example.com" })
        .expect(422);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a body over the configured character limit", async () => {
      const response = await request(app)
        .post(BASE)
        .send({ ...validPayload, body: "x".repeat(100_001) })
        .expect(422);

      // A 422 naming the field, not a Postgres error after the fact.
      expect(response.body.error.details[0].field).toBe("body");
    });

    it("rejects a source that is not a usable grouping key", async () => {
      const response = await request(app)
        .post(BASE)
        .send({ ...validPayload, source: "user service!" })
        .expect(422);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 for malformed JSON", async () => {
      const response = await request(app)
        .post(BASE)
        .set("Content-Type", "application/json")
        .send('{"subject": ')
        .expect(400);

      expect(response.body.error.code).toBe("BAD_REQUEST");
    });
  });

  describe("idempotency", () => {
    it("replays the first message when a key is repeated", async () => {
      const first = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "welcome-user-42")
        .send(validPayload)
        .expect(202);

      const second = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "welcome-user-42")
        .send(validPayload)
        .expect(200);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.headers["idempotent-replay"]).toBe("true");
      // The caller retried after a timeout; the recipient still gets one email.
      expect(harness.repository.size).toBe(1);
    });

    it("returns 409 when a key is reused for a different message", async () => {
      await request(app)
        .post(BASE)
        .set("Idempotency-Key", "welcome-user-42")
        .send(validPayload)
        .expect(202);

      const response = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "welcome-user-42")
        .send({ ...validPayload, subject: "A different subject" })
        .expect(409);

      expect(response.body.error.code).toBe("CONFLICT");
      expect(harness.repository.size).toBe(1);
    });

    it("creates a second message when no key is supplied", async () => {
      await request(app).post(BASE).send(validPayload).expect(202);
      await request(app).post(BASE).send(validPayload).expect(202);

      expect(harness.repository.size).toBe(2);
    });

    it("rejects a key too short to be meaningful", async () => {
      const response = await request(app)
        .post(BASE)
        .set("Idempotency-Key", "abc")
        .send(validPayload)
        .expect(422);

      expect(response.body.error.details[0].field).toBe("Idempotency-Key");
    });
  });

  describe("GET /emails/:id", () => {
    it("returns a seeded message", async () => {
      const seeded = InMemoryEmailRepository.buildMessage();
      ({ app } = buildHarness(new InMemoryEmailRepository([seeded])));

      const response = await request(app).get(`${BASE}/${seeded.id}`).expect(200);

      expect(response.body.data.id).toBe(seeded.id);
    });

    it("returns 404 for a valid but unknown id", async () => {
      const response = await request(app).get(`${BASE}/${UNKNOWN_ID}`).expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it("returns 422 for a non-UUID id", async () => {
      const response = await request(app).get(`${BASE}/not-a-uuid`).expect(422);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /emails", () => {
    beforeEach(() => {
      harness = buildHarness(
        new InMemoryEmailRepository([
          InMemoryEmailRepository.buildMessage({
            source: "user-service",
            status: "SENT",
            createdAt: new Date("2026-01-03T00:00:00.000Z"),
          }),
          InMemoryEmailRepository.buildMessage({
            source: "order-service",
            status: "DEAD",
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
          }),
          InMemoryEmailRepository.buildMessage({
            source: "order-service",
            status: "PENDING",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          }),
        ]),
      );
      app = harness.app;
    });

    it("lists newest first with pagination metadata", async () => {
      const response = await request(app).get(BASE).expect(200);

      expect(response.body.data).toHaveLength(3);
      expect(response.body.meta).toMatchObject({
        page: 1,
        limit: 20,
        total: 3,
        totalPages: 1,
        hasNextPage: false,
      });
      expect(response.body.data[0].source).toBe("user-service");
    });

    it("filters by status", async () => {
      const response = await request(app).get(`${BASE}?status=DEAD`).expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.meta.total).toBe(1);
    });

    it("filters by source", async () => {
      const response = await request(app).get(`${BASE}?source=order-service`).expect(200);

      expect(response.body.data).toHaveLength(2);
    });

    it("pages through results", async () => {
      const response = await request(app).get(`${BASE}?page=2&limit=2`).expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.meta).toMatchObject({ page: 2, totalPages: 2, hasPreviousPage: true });
    });

    it("rejects an unknown status filter", async () => {
      const response = await request(app).get(`${BASE}?status=NOPE`).expect(422);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a limit beyond the maximum page size", async () => {
      await request(app).get(`${BASE}?limit=5000`).expect(422);
    });
  });

  describe("GET /emails/stats", () => {
    it("reports the outbox depth by status", async () => {
      ({ app } = buildHarness(
        new InMemoryEmailRepository([
          InMemoryEmailRepository.buildMessage({ status: "PENDING" }),
          InMemoryEmailRepository.buildMessage({ status: "DEAD" }),
        ]),
      ));

      const response = await request(app).get(`${BASE}/stats`).expect(200);

      expect(response.body.data).toEqual({
        PENDING: 1,
        SENDING: 0,
        SENT: 0,
        FAILED: 0,
        DEAD: 1,
      });
    });
  });

  describe("POST /emails/:id/retry", () => {
    it("returns a dead-lettered message to the queue", async () => {
      const dead = InMemoryEmailRepository.buildMessage({ status: "DEAD", attempts: 5 });
      ({ app } = buildHarness(new InMemoryEmailRepository([dead])));

      const response = await request(app).post(`${BASE}/${dead.id}/retry`).expect(202);

      expect(response.body.data).toMatchObject({ status: "PENDING", attempts: 0 });
    });

    it("refuses to resend a delivered message", async () => {
      const sent = InMemoryEmailRepository.buildMessage({ status: "SENT" });
      ({ app } = buildHarness(new InMemoryEmailRepository([sent])));

      const response = await request(app).post(`${BASE}/${sent.id}/retry`).expect(409);

      expect(response.body.error.code).toBe("CONFLICT");
    });

    it("returns 404 for an unknown id", async () => {
      await request(app).post(`${BASE}/${UNKNOWN_ID}/retry`).expect(404);
    });
  });

  describe("POST /emails/dispatch", () => {
    it("drives one dispatch cycle on demand", async () => {
      const accepted = await request(app).post(BASE).send(validPayload).expect(202);

      const response = await request(app).post(`${BASE}/dispatch`).expect(200);

      expect(response.body.data).toEqual({ claimed: 1, sent: 1, retrying: 0, dead: 0 });
      expect(harness.repository.get(accepted.body.data.id)).toMatchObject({
        status: "SENT",
        provider: "stub",
      });
    });

    it("is not registered when no dispatcher is wired in", async () => {
      const apiOnly = createApp({
        emailService: new EmailService(new InMemoryEmailRepository(), { maxAttempts: 5 }),
      });

      await request(apiOnly).post(`${BASE}/dispatch`).expect(404);
    });
  });

  describe("cross-cutting concerns", () => {
    it("echoes an inbound correlation id", async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/health`)
        .set("x-request-id", "trace-abc-123")
        .expect(200);

      expect(response.headers["x-request-id"]).toBe("trace-abc-123");
    });

    it("generates a correlation id when none is supplied", async () => {
      const response = await request(app).get(`${API_PREFIX}/health`).expect(200);

      expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("reports readiness failures as 503", async () => {
      const failing = createApp({
        emailService: new EmailService(new InMemoryEmailRepository(), { maxAttempts: 5 }),
        checkReadiness: () => Promise.reject(new Error("connection refused")),
      });

      const response = await request(failing).get(`${API_PREFIX}/health/ready`).expect(503);

      expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    });

    it("returns a structured 404 for unknown routes", async () => {
      const response = await request(app).get("/nope").expect(404);

      expect(response.body).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
      expect(response.body.error.requestId).toBeTruthy();
    });

    it("surfaces a store outage as 503, not as an accepted message", async () => {
      const failing = new InMemoryEmailRepository();
      failing.fail("enqueue");
      ({ app } = buildHarness(failing));

      const response = await request(app).post(BASE).send(validPayload).expect(503);

      expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    });

    it("maps an unexpected repository throw to a 500 without leaking internals", async () => {
      const exploding = new InMemoryEmailRepository();
      // A repository that breaks its own contract by throwing rather than
      // returning `[error, null]` must still not take the process down.
      exploding.findById = () => Promise.reject(new Error("secret db topology detail"));
      ({ app } = buildHarness(exploding));

      const response = await request(app).get(`${BASE}/${UNKNOWN_ID}`).expect(500);

      expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    });
  });
});
