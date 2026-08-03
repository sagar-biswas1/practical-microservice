import type { User } from "../../generated/prisma/client.js";
import type { PrismaClient } from "../../lib/prisma.js";
import { attempt, type Result } from "../../utils/result.js";
import type { CreateUserInput, UpdateUserInput } from "./user.schema.js";

export type { User };

/** The row as written to the database; `id` and timestamps are the store's. */
export type NewUserRecord = CreateUserInput;

/**
 * Persistence boundary for users. The service layer depends on this
 * interface, not on Prisma — which is what lets the tests swap in an
 * in-memory implementation and keeps the storage engine replaceable.
 *
 * Every method is error-first. A lookup that finds nothing is `[null, null]`,
 * not an error: absence is an ordinary answer to a query, and only the
 * service knows whether it means "404" or "good, the email is free". A
 * database that refused to answer is `[error, null]` — already normalised to
 * an `AppError` by `attempt`, so callers never handle a raw Prisma type.
 */
export interface UserRepository {
  createUser(input: NewUserRecord): Promise<Result<User>>;
  getUserById(id: string): Promise<Result<User | null>>;
  getUserByAuthUserId(authUserId: string): Promise<Result<User | null>>;
  getUserByEmail(email: string): Promise<Result<User | null>>;
  updateUser(id: string, input: UpdateUserInput): Promise<Result<User>>;
  deleteUser(id: string): Promise<Result<void>>;
}

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  createUser(input: NewUserRecord): Promise<Result<User>> {
    return attempt(() => this.prisma.user.create({ data: input }));
  }

  getUserById(id: string): Promise<Result<User | null>> {
    return attempt(() => this.prisma.user.findUnique({ where: { id } }));
  }

  getUserByAuthUserId(authUserId: string): Promise<Result<User | null>> {
    return attempt(() => this.prisma.user.findUnique({ where: { authUserId } }));
  }

  getUserByEmail(email: string): Promise<Result<User | null>> {
    return attempt(() => this.prisma.user.findUnique({ where: { email } }));
  }

  updateUser(id: string, input: UpdateUserInput): Promise<Result<User>> {
    return attempt(() => this.prisma.user.update({ where: { id }, data: input }));
  }

  async deleteUser(id: string): Promise<Result<void>> {
    const [error] = await attempt(() => this.prisma.user.delete({ where: { id } }));
    return error ? [error, null] : [null, undefined];
  }
}
