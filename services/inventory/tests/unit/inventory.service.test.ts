import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "../../src/errors/app-error.js";
import { InventoryService } from "../../src/modules/inventory/inventory.service.js";
import { InMemoryInventoryRepository } from "../helpers/in-memory-inventory-repository.js";

describe("InventoryService", () => {
  let repository: InMemoryInventoryRepository;
  let service: InventoryService;

  const seedWith = (overrides = {}) => {
    const item = InMemoryInventoryRepository.buildItem(overrides);
    repository = new InMemoryInventoryRepository([item]);
    service = new InventoryService(repository);
    return item;
  };

  beforeEach(() => {
    repository = new InMemoryInventoryRepository();
    service = new InventoryService(repository);
  });

  describe("create", () => {
    it("rejects a duplicate SKU", async () => {
      const input = {
        sku: "SKU-DUP",
        productId: "1c9e6679-7425-40de-944b-e07fc1f90ae7",
        warehouse: "default",
        quantity: 5,
        reorderLevel: 1,
      };
      await service.create(input);

      await expect(service.create(input)).rejects.toThrowError(ConflictError);
    });

    it("records an opening INBOUND movement for non-zero stock", async () => {
      await service.create({
        sku: "SKU-NEW",
        productId: "1c9e6679-7425-40de-944b-e07fc1f90ae7",
        warehouse: "default",
        quantity: 25,
        reorderLevel: 5,
      });

      expect(repository.movementCount).toBe(1);
    });
  });

  describe("update", () => {
    it("patches any column and records who changed what", async () => {
      const item = seedWith({ warehouse: "default", reorderLevel: 10 });

      const result = await service.update(
        item.id,
        { warehouse: "north", reorderLevel: 25 },
        "user-42",
      );

      expect(result.warehouse).toBe("north");
      expect(result.reorderLevel).toBe(25);

      const { items: logs } = await service.listAuditLogs(item.id, { page: 1, limit: 20 });
      expect(logs).toHaveLength(2);
      expect(logs).toContainEqual(
        expect.objectContaining({
          field: "warehouse",
          oldValue: "default",
          newValue: "north",
          actor: "user-42",
        }),
      );
    });

    it("records an unattributed change when no actor is supplied", async () => {
      const item = seedWith({ reorderLevel: 10 });

      await service.update(item.id, { reorderLevel: 25 });

      const { items: logs } = await service.listAuditLogs(item.id, { page: 1, limit: 20 });
      expect(logs[0]).toMatchObject({ field: "reorderLevel", actor: null });
    });

    it("writes nothing when the patch changes no values", async () => {
      const item = seedWith({ warehouse: "default", reorderLevel: 10 });

      await service.update(item.id, { warehouse: "default", reorderLevel: 10 }, "user-42");

      expect(repository.auditLogCount).toBe(0);
      expect(repository.movementCount).toBe(0);
    });

    it("logs a quantity edit to the stock ledger as well", async () => {
      const item = seedWith({ quantity: 100, reserved: 0 });

      await service.update(item.id, { quantity: 80 }, "user-42");

      const { items: movements } = await service.listMovements(item.id, { page: 1, limit: 20 });
      expect(movements[0]).toMatchObject({
        type: "ADJUSTMENT",
        quantityChanged: 20,
        lastQuantity: 100,
        reason: "Patched by user-42",
      });
    });

    it("refuses a quantity that would fall below reserved units", async () => {
      const item = seedWith({ quantity: 100, reserved: 60 });

      await expect(service.update(item.id, { quantity: 50 })).rejects.toThrowError(ConflictError);
      expect(repository.auditLogCount).toBe(0);
    });

    it("404s on an unknown item", async () => {
      await expect(service.update("missing", { reorderLevel: 5 })).rejects.toThrowError(
        NotFoundError,
      );
    });

    it("filters the trail by field", async () => {
      const item = seedWith({ warehouse: "default", reorderLevel: 10 });

      await service.update(item.id, { warehouse: "north", reorderLevel: 25 }, "user-42");
      const { items, total } = await service.listAuditLogs(item.id, {
        page: 1,
        limit: 20,
        field: "reorderLevel",
      });

      expect(total).toBe(1);
      expect(items[0]).toMatchObject({ oldValue: "10", newValue: "25" });
    });
  });

  describe("derived fields", () => {
    it("exposes available and lowStock on reads", async () => {
      const item = seedWith({ quantity: 20, reserved: 12, reorderLevel: 10 });

      const view = await service.getById(item.id);

      expect(view.available).toBe(8);
      expect(view.lowStock).toBe(true);
    });
  });

  describe("reserve", () => {
    it("moves units from available into reserved", async () => {
      const item = seedWith({ quantity: 50, reserved: 0 });

      const result = await service.reserve(item.id, { quantity: 20 });

      expect(result.quantity).toBe(50);
      expect(result.reserved).toBe(20);
      expect(result.available).toBe(30);
    });

    it("refuses to oversell", async () => {
      const item = seedWith({ quantity: 10, reserved: 8 });

      await expect(service.reserve(item.id, { quantity: 5 })).rejects.toThrowError(ConflictError);
    });

    it("keeps sequential reservations consistent", async () => {
      const item = seedWith({ quantity: 10, reserved: 0 });

      await service.reserve(item.id, { quantity: 6 });
      await service.reserve(item.id, { quantity: 4 });

      await expect(service.reserve(item.id, { quantity: 1 })).rejects.toThrowError(ConflictError);

      const view = await service.getById(item.id);
      expect(view.reserved).toBe(10);
      expect(view.available).toBe(0);
    });

    it("throws NotFoundError for an unknown item", async () => {
      await expect(service.reserve("missing", { quantity: 1 })).rejects.toThrowError(
        NotFoundError,
      );
    });
  });

  describe("release", () => {
    it("returns reserved units to the available pool", async () => {
      const item = seedWith({ quantity: 50, reserved: 30 });

      const result = await service.release(item.id, { quantity: 10 });

      expect(result.reserved).toBe(20);
      expect(result.available).toBe(30);
    });
  });

  describe("fulfil", () => {
    it("ships reserved units, reducing both counters", async () => {
      const item = seedWith({ quantity: 50, reserved: 30 });

      const result = await service.fulfil(item.id, { quantity: 30, reference: "ORDER-9" });

      expect(result.quantity).toBe(20);
      expect(result.reserved).toBe(0);
    });

    it("refuses to ship more than is reserved", async () => {
      const item = seedWith({ quantity: 50, reserved: 5 });

      await expect(service.fulfil(item.id, { quantity: 6 })).rejects.toThrowError(ConflictError);
    });
  });

  describe("receive", () => {
    it("increases on-hand stock", async () => {
      const item = seedWith({ quantity: 5, reserved: 2 });

      const result = await service.receive(item.id, { quantity: 45 });

      expect(result.quantity).toBe(50);
      expect(result.reserved).toBe(2);
    });
  });

  describe("adjust", () => {
    it("applies a signed correction", async () => {
      const item = seedWith({ quantity: 30, reserved: 0 });

      const result = await service.adjust(item.id, { delta: -8, reason: "Damaged in transit" });

      expect(result.quantity).toBe(22);
    });

    it("refuses to adjust below reserved units", async () => {
      const item = seedWith({ quantity: 30, reserved: 25 });

      await expect(
        service.adjust(item.id, { delta: -10, reason: "Stock count" }),
      ).rejects.toThrowError(ConflictError);
    });
  });

  describe("sell", () => {
    it("takes stock straight off the shelf without a reservation", async () => {
      const item = seedWith({ quantity: 50, reserved: 0 });

      const result = await service.sell(item.id, { quantity: 20, reference: "ORDER-3" });

      expect(result.quantity).toBe(30);
      expect(result.reserved).toBe(0);
      expect(result.available).toBe(30);
    });

    it("may not sell units another order has reserved", async () => {
      const item = seedWith({ quantity: 50, reserved: 45 });

      await expect(
        service.sell(item.id, { quantity: 10, reference: "ORDER-4" }),
      ).rejects.toThrowError(ConflictError);
    });

    it("records the sale as OUTBOUND", async () => {
      const item = seedWith({ quantity: 50, reserved: 0 });

      await service.sell(item.id, { quantity: 20, reference: "ORDER-5" });
      const history = await service.listMovements(item.id, { page: 1, limit: 20 });

      expect(history.items[0]).toMatchObject({
        type: "OUTBOUND",
        quantityChanged: 20,
        lastQuantity: 50,
        reference: "ORDER-5",
      });
    });
  });

  describe("acceptReturn", () => {
    it("puts returned units back on the shelf", async () => {
      const item = seedWith({ quantity: 30, reserved: 10 });

      const result = await service.acceptReturn(item.id, { quantity: 5, reference: "ORDER-6" });

      expect(result.quantity).toBe(35);
      expect(result.reserved).toBe(10);
    });

    it("records a RETURN, distinct from a supplier delivery", async () => {
      const item = seedWith({ quantity: 30, reserved: 0 });

      await service.acceptReturn(item.id, { quantity: 5, reference: "ORDER-7" });
      await service.receive(item.id, { quantity: 100, reason: "PO-12" });

      const returns = await service.listMovements(item.id, {
        page: 1,
        limit: 20,
        type: "RETURN",
      });

      expect(returns.total).toBe(1);
      expect(returns.items[0]).toMatchObject({ quantityChanged: 5, lastQuantity: 30 });
    });
  });

  describe("movements", () => {
    it("records one movement per stock operation", async () => {
      const item = seedWith({ quantity: 100, reserved: 0 });

      await service.reserve(item.id, { quantity: 10 });
      await service.release(item.id, { quantity: 4 });
      await service.receive(item.id, { quantity: 50 });

      const history = await service.listMovements(item.id, { page: 1, limit: 20 });

      expect(history.total).toBe(3);
      expect(history.items.map((movement) => movement.type)).toEqual([
        "RESERVATION",
        "RELEASE",
        "INBOUND",
      ]);
    });

    it("logs an adjustment with a positive quantity regardless of direction", async () => {
      const item = seedWith({ quantity: 100, reserved: 0 });

      await service.adjust(item.id, { delta: -15, reason: "Shrinkage" });
      const history = await service.listMovements(item.id, { page: 1, limit: 20 });

      expect(history.items[0]).toMatchObject({
        type: "ADJUSTMENT",
        quantityChanged: 15,
        lastQuantity: 100,
      });
    });
  });

  describe("remove", () => {
    it("blocks deletion while units are reserved", async () => {
      const item = seedWith({ quantity: 10, reserved: 3 });

      await expect(service.remove(item.id)).rejects.toThrowError(ConflictError);
      expect(repository.size).toBe(1);
    });

    it("deletes an item with no outstanding reservations", async () => {
      const item = seedWith({ quantity: 10, reserved: 0 });

      await service.remove(item.id);

      expect(repository.size).toBe(0);
    });
  });
});
