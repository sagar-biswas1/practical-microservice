import type { Express } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { API_PREFIX } from "../../src/routes/index.js";
import type { ServiceRoute } from "../../src/config/services.js";
import { createServiceProxy } from "../../src/proxy/service-proxy.js";
import {
  findClosedPort,
  startStubUpstream,
  type StubUpstream,
} from "../helpers/stub-upstream.js";

const PREFIX = `${API_PREFIX}/products`;

function routeTo(target: string): ServiceRoute {
  return {
    name: "product",
    prefix: PREFIX,
    target,
    healthPath: `${API_PREFIX}/health/live`,
  };
}

function appProxyingTo(target: string): Express {
  // The raw proxy, with no edge policies in front of it: these tests are about
  // the hop itself. Policy behaviour is covered in route-policies.test.ts.
  return createApp({ upstreamHandlers: [createServiceProxy(routeTo(target))] });
}

describe("service proxy", () => {
  let upstream: StubUpstream;
  let app: Express;

  beforeEach(async () => {
    upstream = await startStubUpstream();
    app = appProxyingTo(upstream.url);
  });

  afterEach(async () => {
    await upstream.close();
  });

  describe("forwarding", () => {
    it("forwards the path and query string unchanged", async () => {
      await request(app).get(`${PREFIX}/42?include=stock`).expect(200);

      expect(upstream.received).toHaveLength(1);
      expect(upstream.received[0]?.url).toBe(`${PREFIX}/42?include=stock`);
    });

    it("forwards the collection path itself, not just sub-paths", async () => {
      await request(app).get(PREFIX).expect(200);

      expect(upstream.received[0]?.url).toBe(PREFIX);
    });

    it("relays the request body byte-for-byte", async () => {
      // The regression this guards: mounting a body parser on the gateway
      // would consume the stream and the upstream would receive nothing.
      const payload = { sku: "kbd-100", name: "Mechanical Keyboard", priceCents: 12999 };

      await request(app).post(PREFIX).send(payload).expect(200);

      expect(upstream.received[0]?.method).toBe("POST");
      expect(JSON.parse(upstream.received[0]?.body ?? "")).toEqual(payload);
    });

    it("relays the upstream response body back to the client", async () => {
      const response = await request(app).get(`${PREFIX}/42`).expect(200);

      expect(response.body).toEqual({ success: true, data: { path: `${PREFIX}/42` } });
    });

    it("propagates the correlation id so one id spans both hops", async () => {
      const response = await request(app)
        .get(`${PREFIX}/42`)
        .set("x-request-id", "trace-abc")
        .expect(200);

      expect(upstream.received[0]?.headers["x-request-id"]).toBe("trace-abc");
      expect(response.headers["x-request-id"]).toBe("trace-abc");
    });

    it("adds forwarding headers so the upstream sees the real client", async () => {
      await request(app).get(`${PREFIX}/42`).expect(200);

      expect(upstream.received[0]?.headers["x-forwarded-for"]).toBeDefined();
      expect(upstream.received[0]?.headers["x-forwarded-proto"]).toBeDefined();
    });

    it("does not intercept paths outside its prefix", async () => {
      // `/api/v1/products-internal` shares a string prefix with the route but
      // is a different resource; it must fall through to the 404 handler.
      const response = await request(app).get(`${API_PREFIX}/products-internal`).expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(upstream.received).toHaveLength(0);
    });
  });

  describe("identity", () => {
    it("strips a client-supplied actor so downstream audit logs cannot be forged", async () => {
      await request(app)
        .get(`${PREFIX}/42`)
        .set("x-actor-id", "admin@example.com")
        .expect(200);

      expect(upstream.received[0]?.headers["x-actor-id"]).toBeUndefined();
    });
  });

  describe("upstream failures", () => {
    it("returns 503 in the standard envelope when the upstream refuses the connection", async () => {
      const port = await findClosedPort();
      const response = await request(appProxyingTo(`http://127.0.0.1:${port}`))
        .get(`${PREFIX}/42`)
        .expect(503);

      expect(response.body).toMatchObject({
        success: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
      expect(response.body.error.message).toContain("product");
      expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
    });

    it("returns 504 when the upstream exceeds the proxy timeout", async () => {
      // PROXY_TIMEOUT_MS is 1000 in tests/setup.ts.
      upstream.delayNextBy(3_000);

      const response = await request(app).get(`${PREFIX}/42`).expect(504);

      expect(response.body.error.code).toBe("GATEWAY_TIMEOUT");
    });
  });
});
