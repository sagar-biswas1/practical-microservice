import { randomUUID } from "node:crypto";
import type {
  CallContext as EmailCallContext,
  EmailClient,
  EnqueueEmailInput,
  EnqueuedEmail,
} from "../../src/clients/email.client.js";
import type {
  CallContext as UserCallContext,
  CreateUserProfileInput,
  UserClient,
  UserProfile,
} from "../../src/clients/user.client.js";
import { ConflictError, ServiceUnavailableError } from "../../src/errors/app-error.js";
import { ok, type Result } from "../../src/utils/result.js";

/**
 * Captures the mail the service tried to send.
 *
 * The tests read the six-digit code straight out of `subject`, which is the
 * only way to drive a verification flow end to end without reaching into the
 * service's internals — the plaintext code exists nowhere else by design, and
 * a test that read it from the database would be testing a property the real
 * system deliberately does not have.
 */
export class StubEmailClient implements EmailClient {
  readonly sent: Array<{ input: EnqueueEmailInput; context?: EmailCallContext }> = [];
  private shouldFail = false;

  /** Simulates the email service being unreachable. */
  failNext(value = true): void {
    this.shouldFail = value;
  }

  async enqueue(
    input: EnqueueEmailInput,
    context?: EmailCallContext,
  ): Promise<Result<EnqueuedEmail>> {
    if (this.shouldFail) {
      return [new ServiceUnavailableError("Email service is unreachable"), null];
    }

    this.sent.push({ input, context });
    return ok({ id: randomUUID(), status: "PENDING" });
  }

  /** The six digits from the most recent message sent to an address. */
  codeFor(recipient: string): string {
    const message = [...this.sent].reverse().find((m) => m.input.recipient === recipient);
    if (!message) throw new Error(`No email was sent to ${recipient}`);

    const match = /\b(\d{6})\b/.exec(message.input.subject);
    if (!match?.[1]) throw new Error(`No code found in subject: ${message.input.subject}`);
    return match[1];
  }

  lastSource(): string | undefined {
    return this.sent.at(-1)?.input.source;
  }

  reset(): void {
    this.sent.length = 0;
    this.shouldFail = false;
  }
}

/** Records profile hand-offs, and can be made to fail or to report a conflict. */
export class StubUserClient implements UserClient {
  readonly created: CreateUserProfileInput[] = [];
  private mode: "ok" | "unreachable" | "conflict" = "ok";
  private readonly profiles = new Map<string, UserProfile>();

  setMode(mode: "ok" | "unreachable" | "conflict"): void {
    this.mode = mode;
  }

  /** Pre-registers a profile, as though an earlier hand-off had succeeded. */
  seedProfile(authUserId: string): UserProfile {
    const profile: UserProfile = {
      id: randomUUID(),
      authUserId,
      name: "Seeded User",
      email: `seed-${authUserId}@example.com`,
    };
    this.profiles.set(authUserId, profile);
    return profile;
  }

  async createProfile(
    input: CreateUserProfileInput,
    _context?: UserCallContext,
  ): Promise<Result<UserProfile>> {
    if (this.mode === "unreachable") {
      return [new ServiceUnavailableError("User service is unreachable"), null];
    }
    if (this.mode === "conflict") {
      return [new ConflictError("A user for that authUserId already exists"), null];
    }

    this.created.push(input);
    const profile: UserProfile = {
      id: randomUUID(),
      authUserId: input.authUserId,
      name: input.name,
      email: input.email,
    };
    this.profiles.set(input.authUserId, profile);
    return ok(profile);
  }

  async findByAuthUserId(
    authUserId: string,
    _context?: UserCallContext,
  ): Promise<Result<UserProfile | null>> {
    if (this.mode === "unreachable") {
      return [new ServiceUnavailableError("User service is unreachable"), null];
    }
    return ok(this.profiles.get(authUserId) ?? null);
  }

  reset(): void {
    this.created.length = 0;
    this.profiles.clear();
    this.mode = "ok";
  }
}
