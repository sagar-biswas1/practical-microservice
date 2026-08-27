import type { AppError } from "../../src/errors/app-error.js";
import type { Result } from "../../src/utils/result.js";

/**
 * Unwraps a successful result, failing the test if it is an error.
 *
 * `expect(error).toBeNull()` proves the assertion at runtime but tells the
 * compiler nothing, so `data` stays `T | null` and every subsequent line needs
 * a `?.` or a `!`. This narrows properly *and* fails with the actual error
 * message instead of `Cannot read properties of null`.
 */
export function expectOk<T>(result: Result<T>): T {
  const [error, data] = result;
  if (error) throw new Error(`Expected a successful result, got: ${error.message}`);
  return data;
}

/** Unwraps a failed result, failing the test if it succeeded. */
export function expectFail<T>(result: Result<T>): AppError {
  const [error] = result;
  if (!error) throw new Error("Expected a failed result, got a successful one");
  return error;
}
