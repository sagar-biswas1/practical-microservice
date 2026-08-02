import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { bodyLimit } from "../../src/middlewares/body-limit.js";
import { env } from "../../src/config/env.js";
import { AppError } from "../../src/errors/app-error.js";

/** Minimal stand-in: the middleware only ever reads one header. */
function requestWith(contentLength?: string): Request {
  return {
    get: (name: string) =>
      name.toLowerCase() === "content-length" ? contentLength : undefined,
  } as unknown as Request;
}

function run(contentLength?: string): { next: NextFunction; error: unknown } {
  const next = vi.fn();
  bodyLimit(requestWith(contentLength), {} as Response, next as unknown as NextFunction);
  return { next, error: next.mock.calls[0]?.[0] };
}

describe("bodyLimit", () => {
  it("passes a body under the cap through", () => {
    const { error } = run(String(env.MAX_BODY_BYTES - 1));
    expect(error).toBeUndefined();
  });

  it("passes a body exactly at the cap through", () => {
    const { error } = run(String(env.MAX_BODY_BYTES));
    expect(error).toBeUndefined();
  });

  it("rejects a body over the cap with 413", () => {
    const { error } = run(String(env.MAX_BODY_BYTES + 1));

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(413);
  });

  it("passes a request with no declared length through", () => {
    // Chunked upload: bounding it would mean buffering, which is the
    // upstream's job.
    const { error } = run(undefined);
    expect(error).toBeUndefined();
  });

  it("passes a request with an unparsable length through", () => {
    const { error } = run("not-a-number");
    expect(error).toBeUndefined();
  });
});
