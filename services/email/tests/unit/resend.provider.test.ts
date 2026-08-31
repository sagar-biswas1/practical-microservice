import type { AxiosInstance } from "axios";
import { describe, expect, it, vi } from "vitest";
import { ResendProvider } from "../../src/providers/resend.provider.js";
import type { OutboundEmail } from "../../src/providers/email-provider.js";

const message: OutboundEmail = {
  id: "8f1c6e2a-1111-4111-8111-111111111111",
  from: "noreply@example.com",
  to: "delivered@resend.dev",
  subject: "Welcome",
  body: "Hello there",
  bodyType: "TEXT",
};

type PostArgs = [string, unknown, { headers?: Record<string, string> }];

/** Minimal stand-in for the axios instance the provider is given. */
function stubClient(post: (...args: PostArgs) => unknown): AxiosInstance {
  return { post: vi.fn(post) } as unknown as AxiosInstance;
}

function buildProvider(post: (...args: PostArgs) => unknown): ResendProvider {
  return new ResendProvider({ apiKey: "re_test", client: stubClient(post) });
}

describe("ResendProvider", () => {
  it("returns the provider message id on success", async () => {
    const provider = buildProvider(() => ({ status: 200, data: { id: "resend-abc" } }));

    const [error, result] = await provider.send(message);

    expect(error).toBeNull();
    expect(result).toEqual({ provider: "resend", providerMessageId: "resend-abc" });
  });

  it("sends the message id as the idempotency key", async () => {
    let seen: Record<string, string> | undefined;
    const provider = buildProvider((_url, _data, config) => {
      seen = config.headers;
      return { status: 200, data: { id: "resend-abc" } };
    });

    await provider.send(message);

    // Without this, a retry after a timeout is a second email.
    expect(seen?.["Idempotency-Key"]).toBe(message.id);
  });

  it("sends a text body as `text` and an HTML body as `html`", async () => {
    const payloads: Record<string, unknown>[] = [];
    const provider = buildProvider((_url, data) => {
      payloads.push(data as Record<string, unknown>);
      return { status: 200, data: { id: "resend-abc" } };
    });

    await provider.send(message);
    await provider.send({ ...message, bodyType: "HTML", body: "<b>Hi</b>" });

    expect(payloads[0]).toMatchObject({
      to: ["delivered@resend.dev"],
      text: "Hello there",
    });
    expect(payloads[0]).not.toHaveProperty("html");
    expect(payloads[1]).toMatchObject({ html: "<b>Hi</b>" });
    expect(payloads[1]).not.toHaveProperty("text");
  });

  it.each([
    [500, true],
    [502, true],
    [429, true],
    [408, true],
  ])("treats HTTP %i as retryable", async (status, retryable) => {
    const provider = buildProvider(() => ({ status, data: { message: "nope" }, statusText: "" }));

    const [error] = await provider.send(message);

    expect(error?.retryable).toBe(retryable);
  });

  it.each([
    [422, "validation_error"],
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
  ])("treats HTTP %i as permanent", async (status, name) => {
    const provider = buildProvider(() => ({ status, data: { name }, statusText: "" }));

    const [error] = await provider.send(message);

    // Retrying a refusal the provider will repeat just burns the backoff
    // schedule and delays an operator noticing.
    expect(error?.retryable).toBe(false);
    expect(error?.providerStatus).toBe(status);
  });

  it("surfaces the provider's own message in the error", async () => {
    const provider = buildProvider(() => ({
      status: 422,
      data: { message: "The example.com domain is not verified" },
      statusText: "",
    }));

    const [error] = await provider.send(message);

    expect(error?.message).toMatch(/domain is not verified/);
  });

  it("treats a request that never got a verdict as retryable", async () => {
    const provider = buildProvider(() => {
      throw new Error("ECONNRESET");
    });

    const [error, result] = await provider.send(message);

    // The send may in fact have landed, which is why the idempotency key
    // above is not optional.
    expect(error?.retryable).toBe(true);
    expect(error?.message).toMatch(/ECONNRESET/);
    expect(result).toBeNull();
  });

  it("does not report success on a 2xx with no message id", async () => {
    const provider = buildProvider(() => ({ status: 200, data: {}, statusText: "OK" }));

    const [error] = await provider.send(message);

    expect(error).not.toBeNull();
  });
});
