import { beforeEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../src/errors/app-error.js";
import { UserService } from "../../src/modules/user/user.service.js";
import type { CreateUserInput } from "../../src/modules/user/user.schema.js";
import { InMemoryUserRepository } from "../helpers/in-memory-user-repository.js";

const validInput: CreateUserInput = {
  authUserId: "auth|abc123",
  name: "Ada Lovelace",
  email: "delivered@resend.dev",
  address: "12 Analytical Engine Way",
  phone: "+15550001111",
};

describe("UserService", () => {
  let repository: InMemoryUserRepository;
  let service: UserService;

  const seedWith = (users = [] as ReturnType<typeof InMemoryUserRepository.buildUser>[]): void => {
    repository = new InMemoryUserRepository(users);
    service = new UserService(repository);
  };

  beforeEach(() => {
    seedWith();
  });

  describe("create", () => {
    it("returns [null, user] on success", async () => {
      const [error, user] = await service.create(validInput);

      expect(error).toBeNull();
      expect(user).toMatchObject({
        authUserId: "auth|abc123",
        email: "delivered@resend.dev",
      });
      expect(repository.size).toBe(1);
    });

    it("returns a ConflictError for a duplicate authUserId", async () => {
      await service.create(validInput);

      const [error, user] = await service.create({
        ...validInput,
        email: "different@example.com",
      });

      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ statusCode: 409 });
      expect(user).toBeNull();
      expect(repository.size).toBe(1);
    });

    it("returns a ConflictError for a duplicate email", async () => {
      await service.create(validInput);

      const [error] = await service.create({ ...validInput, authUserId: "auth|other" });

      expect(error).toBeInstanceOf(ConflictError);
      expect(error?.message).toMatch(/email/);
      expect(repository.size).toBe(1);
    });

    it("forwards a repository outage instead of reporting success", async () => {
      repository.fail("getUserByAuthUserId");

      const [error, user] = await service.create(validInput);

      expect(error).toBeInstanceOf(ServiceUnavailableError);
      expect(user).toBeNull();
      // The failure short-circuits: nothing was written.
      expect(repository.size).toBe(0);
    });

    it("does not write when the email lookup fails", async () => {
      repository.fail("getUserByEmail");

      const [error] = await service.create(validInput);

      expect(error).toMatchObject({ statusCode: 503 });
      expect(repository.size).toBe(0);
    });
  });

  describe("getById", () => {
    it("returns a seeded user", async () => {
      const seeded = InMemoryUserRepository.buildUser();
      seedWith([seeded]);

      const [error, user] = await service.getById(seeded.id);

      expect(error).toBeNull();
      expect(user?.id).toBe(seeded.id);
    });

    it("returns NotFoundError for an unknown id", async () => {
      const [error, user] = await service.getById("11111111-1111-4111-8111-111111111111");

      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ statusCode: 404 });
      expect(user).toBeNull();
    });

    it("distinguishes a database outage from a missing row", async () => {
      repository.fail("getUserById");

      const [error] = await service.getById("any-id");

      // Not a 404 — the record may well exist; the store simply did not answer.
      expect(error).not.toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ statusCode: 503 });
    });
  });

  describe("getByAuthUserId", () => {
    it("resolves a login to its profile", async () => {
      const seeded = InMemoryUserRepository.buildUser({ authUserId: "auth|xyz" });
      seedWith([seeded]);

      const [error, user] = await service.getByAuthUserId("auth|xyz");

      expect(error).toBeNull();
      expect(user?.id).toBe(seeded.id);
    });

    it("returns NotFoundError when no profile is linked", async () => {
      const [error] = await service.getByAuthUserId("auth|nobody");

      expect(error).toBeInstanceOf(NotFoundError);
    });
  });

  describe("update", () => {
    it("applies a partial patch", async () => {
      const seeded = InMemoryUserRepository.buildUser({ name: "Old Name" });
      seedWith([seeded]);

      const [error, user] = await service.update(seeded.id, { name: "New Name" });

      expect(error).toBeNull();
      expect(user?.name).toBe("New Name");
      expect(user?.email).toBe(seeded.email);
    });

    it("allows a user to re-submit their own email", async () => {
      const seeded = InMemoryUserRepository.buildUser({ email: "self@example.com" });
      seedWith([seeded]);

      const [error, user] = await service.update(seeded.id, {
        email: "self@example.com",
        name: "Renamed",
      });

      expect(error).toBeNull();
      expect(user?.name).toBe("Renamed");
    });

    it("rejects an email already held by another user", async () => {
      const first = InMemoryUserRepository.buildUser({ email: "taken@example.com" });
      const second = InMemoryUserRepository.buildUser({ email: "free@example.com" });
      seedWith([first, second]);

      const [error] = await service.update(second.id, { email: "taken@example.com" });

      expect(error).toBeInstanceOf(ConflictError);
    });

    it("returns NotFoundError when the user does not exist", async () => {
      const [error] = await service.update("11111111-1111-4111-8111-111111111111", {
        name: "x",
      });

      expect(error).toBeInstanceOf(NotFoundError);
    });

    it("skips the uniqueness lookup when the email is unchanged", async () => {
      const seeded = InMemoryUserRepository.buildUser();
      seedWith([seeded]);
      // Would fail the request if the service consulted it unnecessarily.
      repository.fail("getUserByEmail");

      const [error] = await service.update(seeded.id, { name: "Renamed" });

      expect(error).toBeNull();
    });
  });

  describe("remove", () => {
    it("deletes an existing user", async () => {
      const seeded = InMemoryUserRepository.buildUser();
      seedWith([seeded]);

      const [error] = await service.remove(seeded.id);

      expect(error).toBeNull();
      expect(repository.size).toBe(0);
    });

    it("returns NotFoundError rather than silently succeeding", async () => {
      const [error] = await service.remove("11111111-1111-4111-8111-111111111111");

      expect(error).toBeInstanceOf(NotFoundError);
    });
  });
});
