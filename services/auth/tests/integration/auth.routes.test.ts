import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { AuthService } from "../../src/modules/auth/auth.service.js";
import { InMemoryAuthRepository } from "../helpers/in-memory-auth-repository.js";
import { StubEmailClient, StubUserClient } from "../helpers/stub-clients.js";

/**
 * Exercises the real middleware stack — helmet, cors, request context, Zod
 * validation, the auth guard, the error handler — against in-memory doubles.
 * No port is opened, no database is touched, and no other service has to be
 * running.
 */

const PASSWORD = "correct-horse-battery-staple";
const BASE = "/api/v1/auth";

const registration = {
  email: "ada@example.com",
  username: "ada",
  password: PASSWORD,
  profile: {
    name: "Ada Lovelace",
    address: "12 Analytical Engine Way",
    phone: "+15550001111",
  },
};

describe("auth routes", () => {
  let app: Express;
  let repository: InMemoryAuthRepository;
  let emailClient: StubEmailClient;
  let userClient: StubUserClient;

  beforeEach(() => {
    repository = new InMemoryAuthRepository();
    emailClient = new StubEmailClient();
    userClient = new StubUserClient();

    const authService = new AuthService(repository, emailClient, userClient, {
      verificationTtlMinutes: 15,
      verificationMaxAttempts: 5,
      resendCooldownSeconds: 0,
      maxFailedLoginAttempts: 5,
      lockDurationMinutes: 15,
    });

    app = createApp({ authService });
  });

  /** Runs registration + verification, returning the issued token pair. */
  const signUp = async () => {
    await request(app).post(`${BASE}/register`).send(registration).expect(201);
    const code = emailClient.codeFor(registration.email);

    const response = await request(app)
      .post(`${BASE}/verify-email`)
      .send({ email: registration.email, code })
      .expect(200);

    return response.body.data.tokens as {
      accessToken: string;
      refreshToken: string;
    };
  };

  describe("POST /register", () => {
    it("creates the account and returns 201", async () => {
      const response = await request(app)
        .post(`${BASE}/register`)
        .send(registration)
        .expect(201);

      expect(response.body).toMatchObject({
        success: true,
        data: { emailQueued: true, user: { email: "ada@example.com", verified: false } },
      });
      // The response is serialised JSON — if the hash were on the entity, this
      // is where it would show up.
      expect(JSON.stringify(response.body)).not.toContain("argon2");
      expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
    });

    it("rejects a weak password with a 422 naming the field", async () => {
      const response = await request(app)
        .post(`${BASE}/register`)
        .send({ ...registration, password: "short" })
        .expect(422);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.details[0].field).toBe("password");
    });

    it("rejects a password containing the username", async () => {
      const response = await request(app)
        .post(`${BASE}/register`)
        .send({ ...registration, password: "ada-is-my-username-here" })
        .expect(422);

      expect(response.body.error.details[0].field).toBe("password");
    });

    it("rejects a body with unknown fields", async () => {
      // `strictObject`, so a caller cannot smuggle in `role: "ADMIN"` and hope
      // something downstream reads it.
      await request(app)
        .post(`${BASE}/register`)
        .send({ ...registration, role: "ADMIN" })
        .expect(422);
    });

    it("requires the profile the user service will need", async () => {
      const { profile: _profile, ...withoutProfile } = registration;

      const response = await request(app)
        .post(`${BASE}/register`)
        .send(withoutProfile)
        .expect(422);

      // Caught while the user is still on the form, rather than as a failed
      // hand-off after verification when nobody is left to correct it.
      expect(response.body.error.details[0].field).toContain("profile");
    });

    it("normalises the email and username to lower case", async () => {
      await request(app)
        .post(`${BASE}/register`)
        .send({ ...registration, email: "ADA@Example.COM", username: "AdA" })
        .expect(201);

      // Otherwise `ADA@example.com` and `ada@example.com` are two accounts.
      await request(app).post(`${BASE}/register`).send(registration).expect(409);
    });
  });

  describe("POST /verify-email", () => {
    it("verifies, creates the profile, and returns tokens", async () => {
      await request(app).post(`${BASE}/register`).send(registration).expect(201);
      const code = emailClient.codeFor(registration.email);

      const response = await request(app)
        .post(`${BASE}/verify-email`)
        .send({ email: registration.email, code })
        .expect(200);

      expect(response.body.data).toMatchObject({
        profileCreated: true,
        user: { verified: true },
        tokens: { tokenType: "Bearer" },
      });
      expect(userClient.created).toHaveLength(1);
    });

    it("rejects a malformed code before it reaches the service", async () => {
      await request(app)
        .post(`${BASE}/verify-email`)
        .send({ email: registration.email, code: "12345" })
        .expect(422);

      await request(app)
        .post(`${BASE}/verify-email`)
        .send({ email: registration.email, code: "abcdef" })
        .expect(422);
    });
  });

  describe("POST /login", () => {
    it("returns a token pair", async () => {
      await signUp();

      const response = await request(app)
        .post(`${BASE}/login`)
        .send({ email: registration.email, password: PASSWORD })
        .expect(200);

      expect(response.body.data.tokens.accessToken).toBeTruthy();
    });

    it("answers 401 with one message for both kinds of failure", async () => {
      await signUp();

      const unknown = await request(app)
        .post(`${BASE}/login`)
        .send({ email: "nobody@example.com", password: PASSWORD })
        .expect(401);

      const wrongPassword = await request(app)
        .post(`${BASE}/login`)
        .send({ email: registration.email, password: "definitely-not-it" })
        .expect(401);

      expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
      expect(unknown.body.error.code).toBe(wrongPassword.body.error.code);
    });

    it("does not apply the password policy to an existing account", async () => {
      await signUp();

      // A short password is a 401 (wrong credentials), never a 422. A policy
      // check here would reject accounts whose password predates a rule change
      // — and would describe the rule to whoever asked.
      await request(app)
        .post(`${BASE}/login`)
        .send({ email: registration.email, password: "short" })
        .expect(401);
    });
  });

  describe("POST /refresh", () => {
    it("rotates the pair", async () => {
      const tokens = await signUp();

      const response = await request(app)
        .post(`${BASE}/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);

      expect(response.body.data.refreshToken).not.toBe(tokens.refreshToken);

      await request(app)
        .post(`${BASE}/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
    });

    it("does not require an access token", async () => {
      const tokens = await signUp();

      // The whole point: refresh has to work *after* the access token expired.
      await request(app)
        .post(`${BASE}/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(200);
    });
  });

  describe("authenticated routes", () => {
    it("rejects a request with no token", async () => {
      const response = await request(app).get(`${BASE}/me`).expect(401);

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("rejects a malformed Authorization header", async () => {
      await request(app).get(`${BASE}/me`).set("authorization", "Basic abc").expect(401);
      await request(app).get(`${BASE}/me`).set("authorization", "Bearer").expect(401);
    });

    it("rejects a forged token", async () => {
      await request(app)
        .get(`${BASE}/me`)
        .set("authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged")
        .expect(401);
    });

    it("returns the caller for a valid token", async () => {
      const tokens = await signUp();

      const response = await request(app)
        .get(`${BASE}/me`)
        .set("authorization", `Bearer ${tokens.accessToken}`)
        .expect(200);

      expect(response.body.data).toMatchObject({
        email: registration.email,
        username: "ada",
        verified: true,
      });
      expect(response.body.data).not.toHaveProperty("passwordHash");
    });

    it("lists sessions and marks the current one", async () => {
      const tokens = await signUp();
      await request(app)
        .post(`${BASE}/login`)
        .send({ email: registration.email, password: PASSWORD })
        .expect(200);

      const response = await request(app)
        .get(`${BASE}/sessions`)
        .set("authorization", `Bearer ${tokens.accessToken}`)
        .expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    });

    it("paginates login history", async () => {
      const tokens = await signUp();

      const response = await request(app)
        .get(`${BASE}/login-history?page=1&limit=1`)
        .set("authorization", `Bearer ${tokens.accessToken}`)
        .expect(200);

      expect(response.body.meta).toMatchObject({ page: 1, limit: 1, total: 1 });
    });

    it("records the client address and user agent in the audit trail", async () => {
      await signUp();

      await request(app)
        .post(`${BASE}/login`)
        .set("user-agent", "Mozilla/5.0 (vitest)")
        .set("x-forwarded-for", "203.0.113.7")
        .send({ email: registration.email, password: PASSWORD })
        .expect(200);

      const row = repository.peekLogins().at(-1);
      // `trust proxy` is on, so this is the forwarded address rather than the
      // socket's — which is only safe because the service sits behind the
      // gateway. Exposed directly, that header is whatever the client says.
      expect(row?.ip).toBe("203.0.113.7");
      expect(row?.userAgent).toBe("Mozilla/5.0 (vitest)");
    });
  });

  describe("password flows", () => {
    it("resets a forgotten password and invalidates old sessions", async () => {
      const tokens = await signUp();

      await request(app)
        .post(`${BASE}/forgot-password`)
        .send({ email: registration.email })
        .expect(202);

      const code = emailClient.codeFor(registration.email);

      await request(app)
        .post(`${BASE}/reset-password`)
        .send({ email: registration.email, code, password: "a-completely-new-passphrase" })
        .expect(200);

      await request(app)
        .post(`${BASE}/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);

      await request(app)
        .post(`${BASE}/login`)
        .send({ email: registration.email, password: "a-completely-new-passphrase" })
        .expect(200);
    });

    it("answers forgot-password identically for an unknown address", async () => {
      await signUp();

      const known = await request(app)
        .post(`${BASE}/forgot-password`)
        .send({ email: registration.email })
        .expect(202);

      const unknown = await request(app)
        .post(`${BASE}/forgot-password`)
        .send({ email: "nobody@example.com" })
        .expect(202);

      // Same status, same body. This endpoint needs no credentials, which
      // makes any difference here a free membership oracle.
      expect(unknown.body).toEqual(known.body);
    });

    it("changes a password and keeps the caller signed in", async () => {
      const tokens = await signUp();

      const response = await request(app)
        .post(`${BASE}/change-password`)
        .set("authorization", `Bearer ${tokens.accessToken}`)
        .send({ currentPassword: PASSWORD, password: "a-completely-new-passphrase" })
        .expect(200);

      await request(app)
        .post(`${BASE}/refresh`)
        .send({ refreshToken: response.body.data.refreshToken })
        .expect(200);

      await request(app)
        .post(`${BASE}/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
    });

    it("refuses a change-password without authentication", async () => {
      await request(app)
        .post(`${BASE}/change-password`)
        .send({ currentPassword: PASSWORD, password: "a-completely-new-passphrase" })
        .expect(401);
    });
  });

  describe("POST /logout", () => {
    it("revokes the session and is idempotent", async () => {
      const tokens = await signUp();

      await request(app)
        .post(`${BASE}/logout`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);

      // Repeating it is still a success — the caller's goal is already met.
      await request(app)
        .post(`${BASE}/logout`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(204);

      await request(app)
        .post(`${BASE}/refresh`)
        .send({ refreshToken: tokens.refreshToken })
        .expect(401);
    });
  });

  describe("plumbing", () => {
    it("echoes the correlation id it was given", async () => {
      const response = await request(app)
        .get("/api/v1/health")
        .set("x-request-id", "trace-me-123")
        .expect(200);

      expect(response.headers["x-request-id"]).toBe("trace-me-123");
    });

    it("answers 404 for an unknown route in the standard error envelope", async () => {
      const response = await request(app).get("/api/v1/nope").expect(404);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: "NOT_FOUND" },
      });
    });

    it("answers 401, not 404, for an unknown path under /auth", async () => {
      // A consequence of mounting `authenticate` with `router.use` rather than
      // per route: it runs before the request can fall through to the 404
      // handler. That is the fail-closed direction and is left as is — a route
      // added below that line is protected whether or not its author
      // remembered to protect it.
      await request(app).get(`${BASE}/nope`).expect(401);

      // With a valid token the same path is a plain 404, so the routing table
      // is not being hidden from legitimate callers.
      const tokens = await signUp();
      await request(app)
        .get(`${BASE}/nope`)
        .set("authorization", `Bearer ${tokens.accessToken}`)
        .expect(404);
    });

    it("turns malformed JSON into a 400, not a crash", async () => {
      const response = await request(app)
        .post(`${BASE}/login`)
        .set("content-type", "application/json")
        .send('{"email": "ada@example.com",}')
        .expect(400);

      expect(response.body.error.code).toBe("BAD_REQUEST");
    });
  });
});
