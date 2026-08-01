import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { API_PREFIX } from "../../src/routes/index.js";
import { ProductService } from "../../src/modules/product/product.service.js";
import { InMemoryProductRepository } from "../helpers/in-memory-product-repository.js";

const BASE = `${API_PREFIX}/products`;

const validPayload = {
  sku: "kbd-100",
  name: "Mechanical Keyboard",
  description: "Tactile switches",
  priceCents: 12999,
  currency: "usd",
};

function buildApp(seed = new InMemoryProductRepository()): {
  app: Express;
  repository: InMemoryProductRepository;
} {
  const app = createApp({ productService: new ProductService(seed) });
  return { app, repository: seed };
}

describe("products API", () => {
  let app: Express;
  let repository: InMemoryProductRepository;

  beforeEach(() => {
    ({ app, repository } = buildApp());
  });

  describe("POST /products", () => {
    it("creates a product and normalises SKU and currency", async () => {
      const response = await request(app).post(BASE).send(validPayload).expect(201);

      expect(response.body).toMatchObject({
        success: true,
        data: { sku: "KBD-100", currency: "USD", status: "DRAFT" },
      });
      expect(repository.size).toBe(1);
    });

    it("returns 422 with per-field details for invalid input", async () => {
      const response = await request(app)
        .post(BASE)
        .send({ sku: "x", name: "", priceCents: -5 })
        .expect(422);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");

      const fields = response.body.error.details.map((d: { field: string }) => d.field);
      expect(fields).toEqual(expect.arrayContaining(["sku", "name", "priceCents"]));
    });

    it("rejects unknown fields rather than silently dropping them", async () => {
      const response = await request(app)
        .post(BASE)
        .send({ ...validPayload, isAdmin: true })
        .expect(422);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 409 on a duplicate SKU", async () => {
      await request(app).post(BASE).send(validPayload).expect(201);

      const response = await request(app).post(BASE).send(validPayload).expect(409);

      expect(response.body.error.code).toBe("CONFLICT");
    });

    it("returns 400 for malformed JSON", async () => {
      const response = await request(app)
        .post(BASE)
        .set("Content-Type", "application/json")
        .send('{"sku": ')
        .expect(400);

      expect(response.body.error.code).toBe("BAD_REQUEST");
    });
  });

  describe("GET /products", () => {
    it("returns pagination metadata", async () => {
      const seed = new InMemoryProductRepository(
        Array.from({ length: 3 }, (_, i) =>
          InMemoryProductRepository.buildProduct({ sku: `SKU-${i}` }),
        ),
      );
      ({ app } = buildApp(seed));

      const response = await request(app).get(`${BASE}?page=1&limit=2`).expect(200);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.meta).toMatchObject({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
        hasNextPage: true,
        hasPreviousPage: false,
      });
    });

    it("rejects an out-of-range limit", async () => {
      const response = await request(app).get(`${BASE}?limit=5000`).expect(422);

      expect(response.body.error.details[0].field).toBe("limit");
    });
  });

  describe("GET /products/:id", () => {
    it("returns 404 for a valid but unknown id", async () => {
      const response = await request(app)
        .get(`${BASE}/1c9e6679-7425-40de-944b-e07fc1f90ae7`)
        .expect(404);

      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it("returns 422 for a non-UUID id", async () => {
      const response = await request(app).get(`${BASE}/not-a-uuid`).expect(422);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns a seeded product", async () => {
      const seeded = InMemoryProductRepository.buildProduct();
      ({ app } = buildApp(new InMemoryProductRepository([seeded])));

      const response = await request(app).get(`${BASE}/${seeded.id}`).expect(200);

      expect(response.body.data.id).toBe(seeded.id);
    });
  });

  describe("PATCH /products/:id", () => {
    it("updates a subset of fields", async () => {
      const seeded = InMemoryProductRepository.buildProduct();
      ({ app } = buildApp(new InMemoryProductRepository([seeded])));

      const response = await request(app)
        .patch(`${BASE}/${seeded.id}`)
        .send({ name: "Renamed" })
        .expect(200);

      expect(response.body.data.name).toBe("Renamed");
    });

    it("rejects an empty patch body", async () => {
      const seeded = InMemoryProductRepository.buildProduct();
      ({ app } = buildApp(new InMemoryProductRepository([seeded])));

      await request(app).patch(`${BASE}/${seeded.id}`).send({}).expect(422);
    });
  });

  describe("DELETE /products/:id", () => {
    it("returns 204 and removes the product", async () => {
      const seeded = InMemoryProductRepository.buildProduct();
      const repo = new InMemoryProductRepository([seeded]);
      ({ app } = buildApp(repo));

      await request(app).delete(`${BASE}/${seeded.id}`).expect(204);

      expect(repo.size).toBe(0);
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
        productService: new ProductService(new InMemoryProductRepository()),
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

    it("maps an unexpected service failure to a 500 without leaking internals", async () => {
      const exploding = new InMemoryProductRepository();
      exploding.findById = () => Promise.reject(new Error("secret db topology detail"));

      const boomApp = createApp({ productService: new ProductService(exploding) });

      const response = await request(boomApp)
        .get(`${BASE}/1c9e6679-7425-40de-944b-e07fc1f90ae7`)
        .expect(500);

      expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    });
  });
});
