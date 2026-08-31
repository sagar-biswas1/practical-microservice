import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { routePolicies } from "../../src/config/route-policies.js";
import { API_PREFIX, type ServiceName, type ServiceRoute } from "../../src/config/services.js";
import { createServiceProxy } from "../../src/proxy/service-proxy.js";
import { createPolicyHandlers } from "../../src/proxy/route-policy.js";
import { startStubUpstream, type StubUpstream } from "../helpers/stub-upstream.js";
import { bearer } from "../helpers/tokens.js";

/**
 * The real policy declarations, in front of a stub upstream.
 *
 * Nothing here is a fixture: the policies are the ones `route-policies.ts`
 * ships, so a route that loses its guard fails a test rather than quietly
 * becoming public. The stub is what proves the *negative* case — a rejected
 * request must never reach an upstream at all, which is only observable from
 * the other end of the hop.
 */
function appFor(name: ServiceName, prefix: string, target: string): Express {
  const route: ServiceRoute = {
    name,
    prefix,
    target,
    healthPath: `${API_PREFIX}/health/live`,
  };

  return createApp({
    upstreamHandlers: [
      ...createPolicyHandlers(route, routePolicies[name]),
      createServiceProxy(route),
    ],
  });
}

describe("edge route policies", () => {
  let upstream: StubUpstream;

  beforeEach(async () => {
    upstream = await startStubUpstream();
  });

  afterEach(async () => {
    await upstream.close();
  });

  describe("auth service", () => {
    const PREFIX = `${API_PREFIX}/auth`;
    let app: Express;

    beforeEach(() => {
      app = appFor("auth", PREFIX, upstream.url);
    });

    it("lets the credential endpoints through unauthenticated", async () => {
      // Requiring a token to log in would be circular.
      await request(app).post(`${PREFIX}/login`).send({ email: "a@b.c" }).expect(200);

      expect(upstream.received[0]?.url).toBe(`${PREFIX}/login`);
    });

    it("leaves refresh and logout public so an expired session can recover", async () => {
      await request(app).post(`${PREFIX}/refresh`).send({ refreshToken: "x" }).expect(200);
      await request(app).post(`${PREFIX}/logout`).send({ refreshToken: "x" }).expect(200);

      expect(upstream.received).toHaveLength(2);
    });

    it("rejects a session endpoint with no token, without calling the upstream", async () => {
      const response = await request(app).get(`${PREFIX}/me`).expect(401);

      expect(response.body.error.code).toBe("UNAUTHORIZED");
      expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
      expect(upstream.received).toHaveLength(0);
    });

    it("forwards a session endpoint once the token verifies", async () => {
      await request(app)
        .get(`${PREFIX}/me`)
        .set("authorization", await bearer({ sub: "auth-user-9" }))
        .expect(200);

      expect(upstream.received[0]?.url).toBe(`${PREFIX}/me`);
      // The Authorization header survives the hop: the auth service verifies
      // the same token again and needs it to build its own `req.auth`.
      expect(upstream.received[0]?.headers["authorization"]).toBeDefined();
    });
  });

  describe("token verification", () => {
    const PREFIX = `${API_PREFIX}/auth`;
    let app: Express;

    beforeEach(() => {
      app = appFor("auth", PREFIX, upstream.url);
    });

    it("rejects an expired token", async () => {
      const response = await request(app)
        .get(`${PREFIX}/me`)
        .set("authorization", await bearer({ expiresInSeconds: -60 }))
        .expect(401);

      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("rejects a token signed with a different secret", async () => {
      await request(app)
        .get(`${PREFIX}/me`)
        .set("authorization", await bearer({ secret: "a-completely-different-secret-value" }))
        .expect(401);

      expect(upstream.received).toHaveLength(0);
    });

    it("rejects a token from an unexpected issuer", async () => {
      await request(app)
        .get(`${PREFIX}/me`)
        .set("authorization", await bearer({ issuer: "somewhere-else" }))
        .expect(401);
    });

    it("rejects a malformed Authorization header", async () => {
      await request(app).get(`${PREFIX}/me`).set("authorization", "Basic abc123").expect(401);
      await request(app).get(`${PREFIX}/me`).set("authorization", "Bearer").expect(401);
    });
  });

  describe("identity forwarded downstream", () => {
    const PREFIX = `${API_PREFIX}/auth`;
    let app: Express;

    beforeEach(() => {
      app = appFor("auth", PREFIX, upstream.url);
    });

    it("stamps the token subject into x-actor-id", async () => {
      await request(app)
        .get(`${PREFIX}/me`)
        .set("authorization", await bearer({ sub: "auth-user-42" }))
        .expect(200);

      expect(upstream.received[0]?.headers["x-actor-id"]).toBe("auth-user-42");
    });

    it("overwrites a forged actor with the verified one", async () => {
      // The attack: send a valid token for yourself and an `x-actor-id` naming
      // someone else, hoping the audit log believes the header.
      await request(app)
        .get(`${PREFIX}/me`)
        .set("authorization", await bearer({ sub: "auth-user-42" }))
        .set("x-actor-id", "auth-user-1")
        .expect(200);

      expect(upstream.received[0]?.headers["x-actor-id"]).toBe("auth-user-42");
    });
  });

  describe("product service", () => {
    const PREFIX = `${API_PREFIX}/products`;
    let app: Express;

    beforeEach(() => {
      app = appFor("product", PREFIX, upstream.url);
    });

    it("keeps catalogue reads public", async () => {
      await request(app).get(PREFIX).expect(200);
      await request(app).get(`${PREFIX}/abc`).expect(200);

      expect(upstream.received).toHaveLength(2);
      // A public route forwards no actor, because there is no verified one.
      expect(upstream.received[0]?.headers["x-actor-id"]).toBeUndefined();
    });

    it("requires a token to create a product", async () => {
      await request(app).post(PREFIX).send({ sku: "kbd-100" }).expect(401);

      expect(upstream.received).toHaveLength(0);
    });

    it("returns 403 for an authenticated non-admin", async () => {
      const response = await request(app)
        .delete(`${PREFIX}/abc`)
        .set("authorization", await bearer({ role: "USER" }))
        .expect(403);

      expect(response.body.error.code).toBe("FORBIDDEN");
      expect(upstream.received).toHaveLength(0);
    });

    it("forwards a write from an admin", async () => {
      await request(app)
        .patch(`${PREFIX}/abc`)
        .set("authorization", await bearer({ role: "ADMIN", sub: "admin-1" }))
        .send({ name: "Renamed" })
        .expect(200);

      expect(upstream.received[0]?.method).toBe("PATCH");
      expect(upstream.received[0]?.headers["x-actor-id"]).toBe("admin-1");
    });
  });

  describe("inventory service", () => {
    const PREFIX = `${API_PREFIX}/inventory`;
    let app: Express;

    beforeEach(() => {
      app = appFor("inventory", PREFIX, upstream.url);
    });

    it("requires a caller even to read stock levels", async () => {
      await request(app).get(`${PREFIX}/sku/kbd-100`).expect(401);
      await request(app).get(`${PREFIX}/abc/movements`).expect(401);

      expect(upstream.received).toHaveLength(0);
    });

    it("lets any authenticated caller read", async () => {
      await request(app)
        .get(`${PREFIX}/abc/audit-logs`)
        .set("authorization", await bearer({ role: "USER" }))
        .expect(200);

      expect(upstream.received).toHaveLength(1);
    });

    it("restricts every stock transition to an admin", async () => {
      // The wildcard is what makes this hold for a transition nobody listed.
      const transitions = ["reserve", "release", "fulfil", "sell", "return", "receive", "adjust"];

      for (const transition of transitions) {
        await request(app)
          .post(`${PREFIX}/abc/${transition}`)
          .set("authorization", await bearer({ role: "USER" }))
          .send({ quantity: 1 })
          .expect(403);
      }

      expect(upstream.received).toHaveLength(0);
    });

    it("forwards a stock transition from an admin, body intact", async () => {
      await request(app)
        .post(`${PREFIX}/abc/adjust`)
        .set("authorization", await bearer({ role: "ADMIN" }))
        .send({ quantity: 5, reason: "stocktake" })
        .expect(200);

      expect(JSON.parse(upstream.received[0]?.body ?? "")).toEqual({
        quantity: 5,
        reason: "stocktake",
      });
    });
  });

  describe("user service", () => {
    const PREFIX = `${API_PREFIX}/users`;
    let app: Express;

    beforeEach(() => {
      app = appFor("user", PREFIX, upstream.url);
    });

    it("closes profile creation and auth-id lookup to non-admins", async () => {
      const token = await bearer({ role: "USER" });

      await request(app).post(PREFIX).set("authorization", token).send({}).expect(403);
      await request(app).get(`${PREFIX}/auth/abc`).set("authorization", token).expect(403);

      expect(upstream.received).toHaveLength(0);
    });

    it("asks only for identity on a profile, leaving ownership to the service", async () => {
      await request(app)
        .patch(`${PREFIX}/abc`)
        .set("authorization", await bearer({ role: "USER", sub: "auth-user-7" }))
        .send({ displayName: "New" })
        .expect(200);

      // The gateway cannot know whether this caller owns profile `abc`; it
      // proves who is asking and hands the question on.
      expect(upstream.received[0]?.headers["x-actor-id"]).toBe("auth-user-7");
    });
  });

  describe("email service", () => {
    const PREFIX = `${API_PREFIX}/emails`;
    let app: Express;

    beforeEach(() => {
      app = appFor("email", PREFIX, upstream.url);
    });

    it("closes the whole surface to non-admins", async () => {
      const token = await bearer({ role: "USER" });

      await request(app).get(PREFIX).set("authorization", token).expect(403);
      await request(app).get(`${PREFIX}/stats`).set("authorization", token).expect(403);
      await request(app).post(`${PREFIX}/abc/retry`).set("authorization", token).expect(403);

      expect(upstream.received).toHaveLength(0);
    });

    it("lets an admin through", async () => {
      await request(app)
        .get(`${PREFIX}/stats`)
        .set("authorization", await bearer({ role: "ADMIN" }))
        .expect(200);

      expect(upstream.received).toHaveLength(1);
    });
  });

  describe("paths no policy covers", () => {
    it("still 404s rather than being caught by a neighbouring policy", async () => {
      const app = appFor("product", `${API_PREFIX}/products`, upstream.url);

      const response = await request(app).post(`${API_PREFIX}/products-internal`).expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(upstream.received).toHaveLength(0);
    });
  });
});
