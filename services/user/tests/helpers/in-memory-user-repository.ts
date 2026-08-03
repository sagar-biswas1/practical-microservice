import { randomUUID } from "node:crypto";
import type {
  NewUserRecord,
  User,
  UserRepository,
} from "../../src/modules/user/user.repository.js";
import type { UpdateUserInput } from "../../src/modules/user/user.schema.js";
import { fail, ok, type Result } from "../../src/utils/result.js";
import { ServiceUnavailableError } from "../../src/errors/app-error.js";

type RepositoryMethod = keyof UserRepository;

/**
 * Test double for `UserRepository`. Because the service layer depends on the
 * interface rather than Prisma, the whole HTTP stack can be exercised with no
 * database.
 *
 * It returns error-first tuples exactly as the real one does — including on
 * simulated outages, which is the only way to prove the service forwards a
 * repository failure instead of turning it into an empty success.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, User>();
  private readonly failing = new Set<RepositoryMethod>();

  constructor(seed: User[] = []) {
    for (const user of seed) this.users.set(user.id, user);
  }

  static buildUser(overrides: Partial<User> = {}): User {
    const now = new Date("2026-01-01T00:00:00.000Z");
    return {
      id: randomUUID(),
      authUserId: `auth|${randomUUID()}`,
      name: "Test User",
      email: `user-${randomUUID()}@example.com`,
      address: "1 Test Street",
      phone: "+15550001111",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  /** Makes one method behave as though the database were unreachable. */
  fail(method: RepositoryMethod): void {
    this.failing.add(method);
  }

  private outage<T>(method: RepositoryMethod): Result<T> | null {
    if (!this.failing.has(method)) return null;
    return fail(new ServiceUnavailableError(`${method} is unavailable`));
  }

  async createUser(input: NewUserRecord): Promise<Result<User>> {
    const outage = this.outage<User>("createUser");
    if (outage) return outage;

    const user = InMemoryUserRepository.buildUser(input);
    this.users.set(user.id, user);
    return ok(user);
  }

  async getUserById(id: string): Promise<Result<User | null>> {
    const outage = this.outage<User | null>("getUserById");
    if (outage) return outage;

    return ok(this.users.get(id) ?? null);
  }

  async getUserByAuthUserId(authUserId: string): Promise<Result<User | null>> {
    const outage = this.outage<User | null>("getUserByAuthUserId");
    if (outage) return outage;

    return ok([...this.users.values()].find((user) => user.authUserId === authUserId) ?? null);
  }

  async getUserByEmail(email: string): Promise<Result<User | null>> {
    const outage = this.outage<User | null>("getUserByEmail");
    if (outage) return outage;

    return ok([...this.users.values()].find((user) => user.email === email) ?? null);
  }

  async updateUser(id: string, input: UpdateUserInput): Promise<Result<User>> {
    const outage = this.outage<User>("updateUser");
    if (outage) return outage;

    const current = this.users.get(id);
    if (!current) return fail(new ServiceUnavailableError(`User ${id} vanished mid-update`));

    const updated: User = { ...current, ...input, updatedAt: new Date() };
    this.users.set(id, updated);
    return ok(updated);
  }

  async deleteUser(id: string): Promise<Result<void>> {
    const outage = this.outage<void>("deleteUser");
    if (outage) return outage;

    this.users.delete(id);
    return ok(undefined);
  }

  get size(): number {
    return this.users.size;
  }
}
