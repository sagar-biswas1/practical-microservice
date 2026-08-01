import { describe, expect, it } from "vitest";
import { ConflictError, UnprocessableEntityError } from "../../src/errors/app-error.js";
import {
  assertInvariants,
  availableStock,
  isLowStock,
  planAdjustment,
  planFulfilment,
  planReceipt,
  planRelease,
  planReservation,
} from "../../src/modules/inventory/inventory.rules.js";

describe("inventory rules", () => {
  describe("availableStock", () => {
    it("excludes reserved units", () => {
      expect(availableStock({ quantity: 100, reserved: 30 })).toBe(70);
    });
  });

  describe("isLowStock", () => {
    it("is true when available stock reaches the reorder level", () => {
      expect(isLowStock({ quantity: 15, reserved: 5, reorderLevel: 10 })).toBe(true);
    });

    it("is false while available stock stays above the reorder level", () => {
      expect(isLowStock({ quantity: 100, reserved: 5, reorderLevel: 10 })).toBe(false);
    });
  });

  describe("planReservation", () => {
    it("reserves against available stock", () => {
      expect(planReservation({ quantity: 100, reserved: 20 }, 30)).toEqual({
        quantity: 100,
        reserved: 50,
      });
    });

    it("refuses to oversell already-reserved units", () => {
      expect(() => planReservation({ quantity: 100, reserved: 90 }, 20)).toThrowError(
        ConflictError,
      );
    });

    it("allows reserving exactly the available amount", () => {
      expect(planReservation({ quantity: 100, reserved: 90 }, 10)).toEqual({
        quantity: 100,
        reserved: 100,
      });
    });
  });

  describe("planRelease", () => {
    it("returns reserved units to the pool", () => {
      expect(planRelease({ quantity: 100, reserved: 40 }, 15)).toEqual({
        quantity: 100,
        reserved: 25,
      });
    });

    it("refuses to release more than is reserved", () => {
      expect(() => planRelease({ quantity: 100, reserved: 10 }, 11)).toThrowError(ConflictError);
    });
  });

  describe("planFulfilment", () => {
    it("ships reserved units out of on-hand stock", () => {
      expect(planFulfilment({ quantity: 100, reserved: 40 }, 40)).toEqual({
        quantity: 60,
        reserved: 0,
      });
    });

    it("refuses to ship unreserved stock", () => {
      expect(() => planFulfilment({ quantity: 100, reserved: 5 }, 10)).toThrowError(ConflictError);
    });
  });

  describe("planReceipt", () => {
    it("adds to on-hand stock without touching reservations", () => {
      expect(planReceipt({ quantity: 10, reserved: 5 }, 25)).toEqual({
        quantity: 35,
        reserved: 5,
      });
    });
  });

  describe("planAdjustment", () => {
    it("applies a positive correction", () => {
      expect(planAdjustment({ quantity: 10, reserved: 0 }, 5)).toEqual({
        quantity: 15,
        reserved: 0,
      });
    });

    it("applies a negative correction down to the reserved floor", () => {
      expect(planAdjustment({ quantity: 10, reserved: 4 }, -6)).toEqual({
        quantity: 4,
        reserved: 4,
      });
    });

    it("refuses a correction that would cut into reserved stock", () => {
      expect(() => planAdjustment({ quantity: 10, reserved: 4 }, -7)).toThrowError(ConflictError);
    });
  });

  describe("assertInvariants", () => {
    it("accepts a consistent state", () => {
      expect(() => assertInvariants({ quantity: 10, reserved: 10 })).not.toThrow();
    });

    it("rejects negative on-hand stock", () => {
      expect(() => assertInvariants({ quantity: -1, reserved: 0 })).toThrowError(
        UnprocessableEntityError,
      );
    });

    it("rejects negative reservations", () => {
      expect(() => assertInvariants({ quantity: 10, reserved: -1 })).toThrowError(
        UnprocessableEntityError,
      );
    });

    it("rejects reserving more than exists", () => {
      expect(() => assertInvariants({ quantity: 5, reserved: 6 })).toThrowError(ConflictError);
    });
  });
});
