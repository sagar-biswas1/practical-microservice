import type { AppError } from "../errors/app-error.js";
import { toAppError } from "../errors/normalize.js";

/**
 * Error-first results, Node-callback style but awaited: `[error, data]`.
 *
 * Every repository and service method returns one of these instead of
 * throwing. The failure is part of the signature, so a caller cannot forget
 * about it — TypeScript refuses to hand over `data` until `error` has been
 * checked. That is the whole point of the pattern here: an unhandled failure
 * becomes a compile error rather than an exception discovered in production.
 *
 * The two members are discriminated by the first element (`null` vs an
 * `AppError`), which is what lets control-flow analysis narrow the *second*
 * element from a destructuring:
 *
 * ```ts
 * const [error, user] = await service.getById(id);
 * if (error) return next(error);   // here `user` is still `User | null`
 * user.email;                      // narrowed to `User`
 * ```
 *
 * Errors travel as `AppError` because that is the only shape the HTTP layer
 * knows how to render. Anything caught at the edge of the process — a Prisma
 * error, a raw `Error`, a thrown string — is normalised on the way in by
 * `attempt`, so nothing downstream has to guess what it is holding.
 */
export type Ok<T> = [error: null, data: T];
export type Err<E extends Error = AppError> = [error: E, data: null];
export type Result<T, E extends Error = AppError> = Ok<T> | Err<E>;

/** Wraps a value as a success. */
export function ok<T>(data: T): Ok<T> {
  return [null, data];
}

/** Wraps an error as a failure. */
export function fail<E extends Error>(error: E): Err<E> {
  return [error, null];
}

/**
 * Runs a throwing operation and converts the outcome into a result.
 *
 * This is the only place a `try`/`catch` is needed: it sits at the boundary
 * where third-party code (Prisma, an HTTP client) still signals failure by
 * throwing, and everything above it works with tuples.
 */
export async function attempt<T>(operation: () => Promise<T> | T): Promise<Result<T>> {
  try {
    return ok(await operation());
  } catch (error) {
    return fail(toAppError(error));
  }
}
