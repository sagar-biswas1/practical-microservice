import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { API_PREFIX } from "../../src/routes/index.js";
import { InventoryService } from "../../src/modules/inventory/inventory.service.js";
import { InMemoryInventoryRepository } from "../helpers/in-memory-inventory-repository.js";

const BASE = `${API_PREFIX}/inventory`;
const PRODUCT_ID = "1c9e6679-7425-40de-944b-e07fc1f90ae7";

const validPayload = {
  sku: "kbd-100",
  productId: PRODUCT_ID,
  quantity: 100,
  reorderLevel: 10,
};

function buildApp(repository = new InMemoryInventoryRepository()): {
  app: Express;
  repository: InMemoryInventoryRepository;
} {
  return {
    app: createApp({ inventoryService: new InventoryService(repository) }),
    repository,
  };
}

describe("inventory API", () => {
  let app: Express;

  beforeEach(() => {
    ({ app } = buildApp());
  });

  describe("POST /inventory", () => {
    it("creates an item with defaults applied", async () => {
      const response = await request(app).post(BASE).send(validPayload).expect(201);

      expect(response.body.data).toMatchObject({
        sku: "KBD-100",
        warehouse: "default",
        quantity: 100,
        reserved: 0,
        available: 100,
        lowStock: false,
      });
    });

    it("returns 422 for a non-UUID productId", async () => {
      const response = await request(app)
        .post(BASE)
        .send({ ...validPayload, productId: "not-a-uuid" })
        .expect(422);

      expect(response.body.error.details[0].field).toBe("productId");
    });

    it("returns 422 for negative stock", async () => {
      await request(app)
        .post(BASE)
        .send({ ...validPayload, quantity: -1 })
        .expect(422);
    });

    it("returns 409 on a duplicate SKU", async () => {
      await request(app).post(BASE).send(validPayload).expect(201);
      await request(app).post(BASE).send(validPayload).expect(409);
    });
  });

  describe("stock transitions", () => {
    let itemId: string;
    let repository: InMemoryInventoryRepository;

    beforeEach(() => {
      const item = InMemoryInventoryRepository.buildItem({ quantity: 100, reserved: 0 });
      itemId = item.id;
      ({ app, repository } = buildApp(new InMemoryInventoryRepository([item])));
    });

    it("reserves stock", async () => {
      const response = await request(app)
        .post(`${BASE}/${itemId}/reserve`)
        .send({ quantity: 30, reference: "ORDER-1" })
        .expect(200);

      expect(response.body.data).toMatchObject({ reserved: 30, available: 70 });
    });

    it("returns 409 when reserving beyond available stock", async () => {
      const response = await request(app)
        .post(`${BASE}/${itemId}/reserve`)
        .send({ quantity: 500 })
        .expect(409);

      expect(response.body.error.code).toBe("CONFLICT");
      expect(response.body.error.message).toContain("Insufficient stock");
    });

    it("returns 422 for a zero or negative quantity", async () => {
      await request(app).post(`${BASE}/${itemId}/reserve`).send({ quantity: 0 }).expect(422);
      await request(app).post(`${BASE}/${itemId}/reserve`).send({ quantity: -5 }).expect(422);
    });

    it("runs a full reserve → fulfil cycle", async () => {
      await request(app).post(`${BASE}/${itemId}/reserve`).send({ quantity: 40 }).expect(200);

      const response = await request(app)
        .post(`${BASE}/${itemId}/fulfil`)
        .send({ quantity: 40, reference: "ORDER-1" })
        .expect(200);

      expect(response.body.data).toMatchObject({ quantity: 60, reserved: 0, available: 60 });
    });

    it("releases a reservation back to available", async () => {
      await request(app).post(`${BASE}/${itemId}/reserve`).send({ quantity: 40 }).expect(200);

      const response = await request(app)
        .post(`${BASE}/${itemId}/release`)
        .send({ quantity: 25 })
        .expect(200);

      expect(response.body.data).toMatchObject({ reserved: 15, available: 85 });
    });

    it("receives a delivery", async () => {
      const response = await request(app)
        .post(`${BASE}/${itemId}/receive`)
        .send({ quantity: 50, reason: "PO-77" })
        .expect(200);

      expect(response.body.data.quantity).toBe(150);
    });

    it("requires a reason on an adjustment", async () => {
      await request(app).post(`${BASE}/${itemId}/adjust`).send({ delta: -5 }).expect(422);
    });

    it("rejects a zero-delta adjustment", async () => {
      await request(app)
        .post(`${BASE}/${itemId}/adjust`)
        .send({ delta: 0, reason: "no-op" })
        .expect(422);
    });

    it("returns 409 when an adjustment would cut into reserved stock", async () => {
      await request(app).post(`${BASE}/${itemId}/reserve`).send({ quantity: 95 }).expect(200);

      await request(app)
        .post(`${BASE}/${itemId}/adjust`)
        .send({ delta: -50, reason: "Stock count" })
        .expect(409);
    });

    it("exposes the movement history", async () => {
      await request(app).post(`${BASE}/${itemId}/reserve`).send({ quantity: 10 }).expect(200);
      await request(app).post(`${BASE}/${itemId}/receive`).send({ quantity: 10 }).expect(200);

      const response = await request(app).get(`${BASE}/${itemId}/movements`).expect(200);

      expect(response.body.meta.total).toBe(2);
      expect(repository.movementCount).toBe(2);
    });

    it("filters movement history by type", async () => {
      await request(app).post(`${BASE}/${itemId}/reserve`).send({ quantity: 10 }).expect(200);
      await request(app).post(`${BASE}/${itemId}/receive`).send({ quantity: 10 }).expect(200);

      const response = await request(app)
        .get(`${BASE}/${itemId}/movements?type=INBOUND`)
        .expect(200);

      expect(response.body.meta.total).toBe(1);
    });

    it("returns 404 for stock operations on an unknown item", async () => {
      await request(app)
        .post(`${BASE}/2c9e6679-7425-40de-944b-e07fc1f90ae8/reserve`)
        .send({ quantity: 1 })
        .expect(404);
    });
  });

  describe("GET /inventory", () => {
    it("filters to low-stock items", async () => {
      const healthy = InMemoryInventoryRepository.buildItem({
        sku: "OK-1",
        quantity: 100,
        reserved: 0,
        reorderLevel: 10,
      });
      const low = InMemoryInventoryRepository.buildItem({
        sku: "LOW-1",
        quantity: 12,
        reserved: 5,
        reorderLevel: 10,
      });
      ({ app } = buildApp(new InMemoryInventoryRepository([healthy, low])));

      const response = await request(app).get(`${BASE}?lowStock=true`).expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].sku).toBe("LOW-1");
    });

    it("filters by productId", async () => {
      const mine = InMemoryInventoryRepository.buildItem({ sku: "A", productId: PRODUCT_ID });
      const other = InMemoryInventoryRepository.buildItem({ sku: "B" });
      ({ app } = buildApp(new InMemoryInventoryRepository([mine, other])));

      const response = await request(app).get(`${BASE}?productId=${PRODUCT_ID}`).expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].sku).toBe("A");
    });
  });

  describe("GET /inventory/sku/:sku", () => {
    it("looks an item up by SKU, case-insensitively", async () => {
      const item = InMemoryInventoryRepository.buildItem({ sku: "FIND-ME" });
      ({ app } = buildApp(new InMemoryInventoryRepository([item])));

      const response = await request(app).get(`${BASE}/sku/find-me`).expect(200);

      expect(response.body.data.id).toBe(item.id);
    });

    it("returns 404 for an unknown SKU", async () => {
      await request(app).get(`${BASE}/sku/NOPE-1`).expect(404);
    });
  });

  describe("DELETE /inventory/:id", () => {
    it("returns 409 while units are reserved", async () => {
      const item = InMemoryInventoryRepository.buildItem({ quantity: 10, reserved: 2 });
      ({ app } = buildApp(new InMemoryInventoryRepository([item])));

      const response = await request(app).delete(`${BASE}/${item.id}`).expect(409);

      expect(response.body.error.code).toBe("CONFLICT");
    });

    it("deletes an unreserved item", async () => {
      const item = InMemoryInventoryRepository.buildItem({ quantity: 10, reserved: 0 });
      ({ app } = buildApp(new InMemoryInventoryRepository([item])));

      await request(app).delete(`${BASE}/${item.id}`).expect(204);
    });
  });

  describe("cross-cutting concerns", () => {
    it("echoes an inbound correlation id", async () => {
      const response = await request(app)
        .get(`${API_PREFIX}/health`)
        .set("x-request-id", "trace-inv-1")
        .expect(200);

      expect(response.headers["x-request-id"]).toBe("trace-inv-1");
    });

    it("reports readiness failures as 503", async () => {
      const failing = createApp({
        inventoryService: new InventoryService(new InMemoryInventoryRepository()),
        checkReadiness: () => Promise.reject(new Error("connection refused")),
      });

      await request(failing).get(`${API_PREFIX}/health/ready`).expect(503);
    });

    it("returns a structured 404 for unknown routes", async () => {
      const response = await request(app).get("/nope").expect(404);

      expect(response.body).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    });
  });
});
