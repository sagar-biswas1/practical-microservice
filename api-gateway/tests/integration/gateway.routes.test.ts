import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { API_PREFIX } from "../../src/routes/index.js";
import type { DependencyReport } from "../../src/modules/health/health.routes.js";

function buildApp(checkReadiness?: () => Promise<DependencyReport>): Express {
  // No proxies: these tests cover the gateway's own surface, so an empty list
  // keeps every unmatched path falling through to the 404 handler.
  return createApp({ proxies: [], ...(checkReadiness ? { checkReadiness } : {}) });
}

describe("gateway surface", () => {
  describe("GET /", () => {
    it("advertises the service and its routing table", async () => {
      const response = await request(buildApp()).get("/").expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: { service: "api-gateway-test", apiPrefix: API_PREFIX },
      });
      expect(response.body.data.upstreams).toEqual([
        { name: "product", prefix: `${API_PREFIX}/products` },
        { name: "inventory", prefix: `${API_PREFIX}/inventory` },
        { name: "user", prefix: `${API_PREFIX}/users` },
      ]);
    });
  });

  describe("health", () => {
    it("reports liveness without touching upstreams", async () => {
      const response = await request(buildApp()).get(`${API_PREFIX}/health/live`).expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: { status: "ok", service: "api-gateway-test" },
      });
    });

    it("reports ready when every upstream answers", async () => {
      const app = buildApp(async () => ({
        product: { status: "up", latencyMs: 3 },
        inventory: { status: "up", latencyMs: 4 },
      }));

      const response = await request(app).get(`${API_PREFIX}/health/ready`).expect(200);

      expect(response.body).toMatchObject({
        success: true,
        data: { status: "ready", dependencies: { product: { status: "up" } } },
      });
    });

    it("returns 503 naming the upstream that is down", async () => {
      const app = buildApp(async () => ({
        product: { status: "up", latencyMs: 3 },
        inventory: { status: "down", latencyMs: 500, message: "connect ECONNREFUSED" },
      }));

      const response = await request(app).get(`${API_PREFIX}/health/ready`).expect(503);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe("SERVICE_UNAVAILABLE");
      expect(response.body.error.details).toEqual([
        { field: "inventory", message: "connect ECONNREFUSED" },
      ]);
      // The full report still comes back, so a probe can see what *is* healthy.
      expect(response.body.data.dependencies.product.status).toBe("up");
    });
  });

  describe("correlation", () => {
    it("generates a request id and echoes it back", async () => {
      const response = await request(buildApp()).get("/").expect(200);

      expect(response.headers["x-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("honours an inbound request id so one trace spans the chain", async () => {
      const response = await request(buildApp())
        .get("/")
        .set("x-request-id", "trace-from-the-edge")
        .expect(200);

      expect(response.headers["x-request-id"]).toBe("trace-from-the-edge");
    });

    it("replaces an implausibly long inbound id rather than propagating it", async () => {
      const response = await request(buildApp())
        .get("/")
        .set("x-request-id", "x".repeat(201))
        .expect(200);

      expect(response.headers["x-request-id"]).not.toBe("x".repeat(201));
    });
  });

  describe("unmatched routes", () => {
    it("returns a 404 in the standard envelope with the correlation id", async () => {
      const response = await request(buildApp()).get("/nope").expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(response.body.error.message).toContain("/nope");
      expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
    });
  });
});
