import { ConflictError, NotFoundError } from "../../errors/app-error.js";
import { fail, ok, type Result } from "../../utils/result.js";
import type { User, UserRepository } from "./user.repository.js";
import type { CreateUserInput, UpdateUserInput } from "./user.schema.js";

/**
 * Business rules for user profiles. Deliberately free of Express and Prisma
 * types so it can be unit-tested directly and reused from a queue consumer or
 * CLI.
 *
 * Nothing in here throws. Each method returns `[error, data]`, and each call
 * it makes is unpacked the same way, so a failure is either handled or
 * explicitly forwarded — there is no third option where it goes unnoticed.
 *
 * This service owns the *profile*, not the login. `authUserId` is a soft
 * reference to whatever identity provider authenticated the caller;
 * deliberately not a foreign key, because that record lives outside this
 * database and its lifecycle is not ours to enforce.
 */
export class UserService {
  constructor(private readonly repository: UserRepository) {}

  /**
   * Creates a profile.
   *
   * Both uniqueness checks are advisory: they exist to return a clear 409
   * naming the field, not to guarantee anything. Two concurrent creates can
   * still both pass them, and the unique indexes on `auth_user_id` and
   * `email` are what actually settles it — Prisma's P2002 is normalised to
   * the same 409, so the loser of the race gets the same answer either way.
   */
  async create(input: CreateUserInput): Promise<Result<User>> {
    const [authLookupError, byAuthUserId] = await this.repository.getUserByAuthUserId(
      input.authUserId,
    );
    if (authLookupError) return fail(authLookupError);
    if (byAuthUserId) {
      return fail(
        new ConflictError(`A user for authUserId '${input.authUserId}' already exists`),
      );
    }

    const [emailLookupError, byEmail] = await this.repository.getUserByEmail(input.email);
    if (emailLookupError) return fail(emailLookupError);
    if (byEmail) {
      return fail(new ConflictError(`A user with email '${input.email}' already exists`));
    }

    return this.repository.createUser(input);
  }

  async getById(id: string): Promise<Result<User>> {
    const [error, user] = await this.repository.getUserById(id);
    if (error) return fail(error);
    if (!user) return fail(new NotFoundError(`User '${id}' was not found`));
    return ok(user);
  }

  /**
   * The lookup other services use: they hold the identity provider's id, not
   * this service's, so this is how a login is resolved to a profile.
   */
  async getByAuthUserId(authUserId: string): Promise<Result<User>> {
    const [error, user] = await this.repository.getUserByAuthUserId(authUserId);
    if (error) return fail(error);
    if (!user) return fail(new NotFoundError(`No user found for authUserId '${authUserId}'`));
    return ok(user);
  }

  /**
   * The existence check is not redundant with the update itself: Prisma
   * reports a missing row on update as P2025, which normalises to a 404 with
   * a generic message. Loading first means the 404 names the user, and it
   * keeps "no such user" distinguishable from "the row vanished mid-write".
   */
  async update(id: string, input: UpdateUserInput): Promise<Result<User>> {
    const [lookupError, current] = await this.getById(id);
    if (lookupError) return fail(lookupError);

    // Only when the email actually moves — re-submitting the user's own
    // address must not collide with their own row.
    if (input.email && input.email !== current.email) {
      const [emailLookupError, byEmail] = await this.repository.getUserByEmail(input.email);
      if (emailLookupError) return fail(emailLookupError);
      if (byEmail && byEmail.id !== id) {
        return fail(new ConflictError(`A user with email '${input.email}' already exists`));
      }
    }

    return this.repository.updateUser(id, input);
  }

  /** Deleting an unknown user is a 404, not a silent success. */
  async remove(id: string): Promise<Result<void>> {
    const [error] = await this.getById(id);
    if (error) return fail(error);
    return this.repository.deleteUser(id);
  }
}
