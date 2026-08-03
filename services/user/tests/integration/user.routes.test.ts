import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { API_PREFIX } from "../../src/routes/index.js";
import { UserService } from "../../src/modules/user/user.service.js";
import { InMemoryUserRepository } from "../helpers/in-memory-user-repository.js";

const BASE = `${API_PREFIX}/users`;
const UNKNOWN_ID = "1c9e6679-7425-40de-944b-e07fc1f90ae7";

const validPayload = {
  authUserId: "auth|abc123",
  name: "Ada Lovelace",
  email: "Ada@Example.com",
  address: "12 Analytical Engine Way",
  phone: "+1 555 000 1111",
};

function buildApp(repository = new InMemoryUserRepository()): {
  app: Express;
  repository: InMemoryUserRepository;
} {
  return { app: createApp({ userService: new UserService(repository) }), repository };
}

describe("users API", () => {
  let app: Express;
  let repository: InMemoryUserRepository;

  beforeEach(() => {
    ({ app, repository } = buildApp());
  });

  describe("POST /users", () => {
    it("creates a user and normalises the email to lower case", async () => {
      const response = await request(app).post(BASE).send(validPayload).expect(201);

      expect(response.body).toMatchObject({
        success: true,
        data: { authUserId: "auth|abc123", email: "ada@example.com" },
      });
      expect(response.body.data.id).toBeTruthy();
      expect(repository.size).toBe(1);
    });

    it("returns 422 with per-field details for invalid input", async () => {
      const response = await request(app)
        .post(BASE)
        .send({ authUserId: "", name: "", email: "not-an-email", address: "", phone: "1" })
        .expect(422);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");

      const fields = response.body.error.details.map((d: { field: string }) => d.field);
      expect(fields).toEqual(
        expect.arrayContaining(["authUserId", "name", "email", "address", "phone"]),
      );
    });

    it("rejects unknown fields rather than silently dropping them", async () => {
      const response = await request(app)
        .post(BASE)
        .send({ ...validPayload, isAdmin: true })
        .expect(422);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 409 on a duplicate authUserId", async () => {
      await request(app).post(BASE).send(validPayload).expect(201);

      const response = await request(app)
        .post(BASE)
        .send({ ...validPayload, email: "other@example.com" })
        .expect(409);

      expect(response.body.error.code).toBe("CONFLICT");
    });

    it("returns 409 on a duplicate email regardless of casing", async () => {
      await request(app).post(BASE).send(validPayload).expect(201);

      const response = await request(app)
        .post(BASE)
        .send({ ...validPayload, authUserId: "auth|other", email: "ADA@example.com" })
        .expect(409);

      expect(response.body.error.message).toMatch(/email/);
    });

    it("returns 400 for malformed JSON", async () => {
      const response = await request(app)
        .post(BASE)
        .set("Content-Type", "application/json")
        .send('{"name": ')
        .expect(400);

      expect(response.body.error.code).toBe("BAD_REQUEST");
    });
  });

  describe("GET /users/:id", () => {
    it("returns a seeded user", async () => {
      const seeded = InMemoryUserRepository.buildUser();
      ({ app } = buildApp(new InMemoryUserRepository([seeded])));

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

  describe("GET /users/auth/:authUserId", () => {
    it("resolves a login to its profile", async () => {
      const seeded = InMemoryUserRepository.buildUser({ authUserId: "auth|xyz" });
      ({ app } = buildApp(new InMemoryUserRepository([seeded])));

      const response = await request(app).get(`${BASE}/auth/auth|xyz`).expect(200);

      expect(response.body.data.id).toBe(seeded.id);
    });

    it("returns 404 when no profile is linked", async () => {
      const response = await request(app).get(`${BASE}/auth/auth|nobody`).expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("PATCH /users/:id", () => {
    it("updates a subset of fields", async () => {
      const seeded = InMemoryUserRepository.buildUser();
      ({ app } = buildApp(new InMemoryUserRepository([seeded])));

      const response = await request(app)
        .patch(`${BASE}/${seeded.id}`)
        .send({ name: "Renamed" })
        .expect(200);

      expect(response.body.data.name).toBe("Renamed");
    });

    it("rejects an empty patch body", async () => {
      const seeded = InMemoryUserRepository.buildUser();
      ({ app } = buildApp(new InMemoryUserRepository([seeded])));

      await request(app).patch(`${BASE}/${seeded.id}`).send({}).expect(422);
    });

    it("rejects an attempt to repoint authUserId", async () => {
      const seeded = InMemoryUserRepository.buildUser();
      ({ app } = buildApp(new InMemoryUserRepository([seeded])));

      const response = await request(app)
        .patch(`${BASE}/${seeded.id}`)
        .send({ authUserId: "auth|someone-else" })
        .expect(422);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("DELETE /users/:id", () => {
    it("returns 204 and removes the user", async () => {
      const seeded = InMemoryUserRepository.buildUser();
      const repo = new InMemoryUserRepository([seeded]);
      ({ app } = buildApp(repo));

      await request(app).delete(`${BASE}/${seeded.id}`).expect(204);

      expect(repo.size).toBe(0);
    });

    it("returns 404 for an unknown id", async () => {
      await request(app).delete(`${BASE}/${UNKNOWN_ID}`).expect(404);
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
        userService: new UserService(new InMemoryUserRepository()),
        checkReadiness: () => Promise.reject(new Error("connection refused")),
      });

      const response = await request(failing).get(`${API_PREFIX}/health/ready`).expect(503);

      expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    });

    it("returns a structured 404 for unknown routes", async () => {
      const response = await request(app).get("/nope").expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: "NOT_FOUND" },
      });
      expect(response.body.error.requestId).toBeTruthy();
    });

    it("surfaces a repository outage as 503, not as an empty success", async () => {
      const failing = new InMemoryUserRepository();
      failing.fail("getUserById");
      ({ app } = buildApp(failing));

      const response = await request(app).get(`${BASE}/${UNKNOWN_ID}`).expect(503);

      expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
    });

    it("maps an unexpected repository throw to a 500 without leaking internals", async () => {
      const exploding = new InMemoryUserRepository();
      // A repository that breaks its own contract by throwing rather than
      // returning `[error, null]` must still not take the process down.
      exploding.getUserById = () => Promise.reject(new Error("secret db topology detail"));
      ({ app } = buildApp(exploding));

      const response = await request(app).get(`${BASE}/${UNKNOWN_ID}`).expect(500);

      expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    });
  });
});
