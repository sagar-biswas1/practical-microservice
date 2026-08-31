import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createStrictRateLimiter } from "../../src/middlewares/rate-limit.js";
import { errorHandler } from "../../src/middlewares/error-handler.js";

/**
 * The declared limiter skips under `NODE_ENV=test`, so the budget is exercised
 * through a purpose-built instance with that skip turned off. What is being
 * checked is the wiring — that exhausting the budget produces the project's
 * error envelope rather than express-rate-limit's own plain-text 429.
 */
function appWithLimit(limit: number): Express {
  const app = express();

  app.use(
    createStrictRateLimiter({
      name: "authentication",
      windowMs: 60_000,
      limit,
      skip: () => false,
    }),
  );
  app.post("/login", (_req, res) => {
    res.json({ success: true });
  });
  app.use(errorHandler);

  return app;
}

describe("strict rate limiter", () => {
  it("allows requests up to the limit", async () => {
    const app = appWithLimit(2);

    await request(app).post("/login").expect(200);
    await request(app).post("/login").expect(200);
  });

  it("rejects the next request in the standard error envelope", async () => {
    const app = appWithLimit(1);

    await request(app).post("/login").expect(200);
    const response = await request(app).post("/login").expect(429);

    expect(response.body).toMatchObject({
      success: false,
      error: { code: "TOO_MANY_REQUESTS" },
    });
    expect(response.body.error.message).toContain("authentication");
  });

  it("gives each instance its own bucket", async () => {
    // Two limiters means two budgets: sharing one instance across routes is
    // how they are made to draw on a common allowance, and that has to be a
    // deliberate choice rather than an accident of construction.
    const first = appWithLimit(1);
    const second = appWithLimit(1);

    await request(first).post("/login").expect(200);
    await request(first).post("/login").expect(429);
    await request(second).post("/login").expect(200);
  });
});
