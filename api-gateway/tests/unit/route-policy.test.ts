import { describe, expect, it } from "vitest";
import { compilePolicyPath } from "../../src/proxy/route-policy.js";

const PREFIX = "/api/v1/inventory";

const matches = (pattern: string, path: string): boolean =>
  compilePolicyPath(PREFIX, pattern).test(path);

describe("policy path matching", () => {
  describe("the collection root", () => {
    it("matches the prefix itself, with or without a trailing slash", () => {
      expect(matches("/", PREFIX)).toBe(true);
      expect(matches("/", `${PREFIX}/`)).toBe(true);
    });

    it("does not match an item below it", () => {
      expect(matches("/", `${PREFIX}/abc`)).toBe(false);
    });
  });

  describe("parameters", () => {
    it("matches exactly one segment", () => {
      expect(matches("/:id", `${PREFIX}/abc`)).toBe(true);
      expect(matches("/:id", `${PREFIX}/abc/movements`)).toBe(false);
    });

    it("matches a literal that follows a parameter", () => {
      expect(matches("/:id/adjust", `${PREFIX}/abc/adjust`)).toBe(true);
      expect(matches("/:id/adjust", `${PREFIX}/abc/reserve`)).toBe(false);
    });
  });

  describe("wildcards", () => {
    it("covers the prefix and everything below it", () => {
      expect(matches("/*", PREFIX)).toBe(true);
      expect(matches("/*", `${PREFIX}/abc`)).toBe(true);
      expect(matches("/*", `${PREFIX}/abc/movements`)).toBe(true);
    });

    it("spans several segments after a parameter", () => {
      expect(matches("/:id/*", `${PREFIX}/abc/reserve`)).toBe(true);
      expect(matches("/:id/*", `${PREFIX}/abc/deeply/nested`)).toBe(true);
      // The parameter still has to be there.
      expect(matches("/:id/*", PREFIX)).toBe(false);
    });

    it("is rejected anywhere but the last segment", () => {
      expect(() => compilePolicyPath(PREFIX, "/*/adjust")).toThrow(/last segment/);
    });
  });

  describe("prefix boundaries", () => {
    it("does not match a sibling path that merely shares a string prefix", () => {
      // The failure this guards: a policy on `/inventory` silently covering,
      // or failing to cover, `/inventory-internal`.
      expect(matches("/*", `${PREFIX}-internal`)).toBe(false);
      expect(matches("/", `${PREFIX}-internal`)).toBe(false);
    });

    it("treats the prefix as literal text, not as a pattern", () => {
      expect(compilePolicyPath("/api/v1/a.c", "/").test("/api/v1/abc")).toBe(false);
    });
  });
});
