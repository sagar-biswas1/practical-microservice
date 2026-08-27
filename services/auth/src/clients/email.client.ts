import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import { env } from "../config/env.js";
import { ServiceUnavailableError } from "../errors/app-error.js";
import { REQUEST_ID_HEADER } from "../middlewares/request-context.js";
import { attempt, type Result } from "../utils/result.js";

/**
 * Client for the email service's outbox.
 *
 * A copy of a contract owned by another service, not a shared type: it is
 * allowed to lag behind theirs, and only the fields listed here are relied on.
 */
export interface EnqueueEmailInput {
  recipient: string;
  subject: string;
  body: string;
  bodyType?: "TEXT" | "HTML";
  /** Slug-ish origin tag; the email service rejects free text here. */
  source: string;
}

export interface EnqueuedEmail {
  id: string;
  status: string;
}

/** Correlation carried from the inbound request. */
export interface CallContext {
  requestId?: string | undefined;
  /**
   * De-duplication token. The email service writes it in the same transaction
   * as the message, so a retry after a timeout returns the original instead of
   * mailing the recipient twice.
   */
  idempotencyKey?: string | undefined;
}

export interface EmailClient {
  enqueue(input: EnqueueEmailInput, context?: CallContext): Promise<Result<EnqueuedEmail>>;
}

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { message?: string };
}

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export class HttpEmailClient implements EmailClient {
  private readonly http: AxiosInstance;

  constructor(
    baseUrl: string = env.EMAIL_SERVICE_URL,
    timeoutMs: number = env.EMAIL_TIMEOUT_MS,
    http?: AxiosInstance,
  ) {
    this.http =
      http ??
      axios.create({
        baseURL: baseUrl,
        timeout: timeoutMs,
        headers: { accept: "application/json" },
        // Every status is a normal response; only transport failures reject.
        // Status handling then lives in one place instead of being split
        // between the happy path and an error interceptor.
        validateStatus: () => true,
      });
  }

  /**
   * Hands a message to the outbox.
   *
   * Error-first rather than throwing, unlike the product service's inventory
   * client, because the *caller* here treats a mail failure as survivable: the
   * account has already been created and committed, and a user who never got
   * their code can ask for another one. Making that a tuple keeps the choice
   * visible at the call site instead of hiding it in a `catch`.
   *
   * A `202` from the email service means the row is committed, not that the
   * mail was sent — delivery is its dispatcher's problem, and asking about it
   * is what `GET /emails/:id` is for.
   */
  async enqueue(
    input: EnqueueEmailInput,
    context?: CallContext,
  ): Promise<Result<EnqueuedEmail>> {
    const headers: Record<string, string> = {};
    if (context?.requestId) headers[REQUEST_ID_HEADER] = context.requestId;
    if (context?.idempotencyKey) headers[IDEMPOTENCY_KEY_HEADER] = context.idempotencyKey;

    const [transportError, response] = await attempt(() =>
      this.http.request<Envelope<EnqueuedEmail>>({
        method: "POST",
        url: "/api/v1/emails",
        headers,
        data: input,
      }),
    );

    if (transportError) {
      // `validateStatus` swallows every status, so reaching here means the
      // request never completed: connection refused, DNS failure, or timeout.
      return [
        new ServiceUnavailableError("Email service is unreachable", transportError),
        null,
      ];
    }

    if (response.status >= 200 && response.status < 300) {
      return [null, response.data.data];
    }

    return [this.toError(response), null];
  }

  /**
   * Translates a failure into this service's vocabulary. A 5xx downstream is a
   * 503 here — the caller's request was fine, a dependency was not — and a 4xx
   * means the payload *this* service sent was rejected, which is our bug and
   * not something the end user can act on.
   */
  private toError(response: AxiosResponse<Envelope<unknown>>): ServiceUnavailableError {
    const message = response.data?.error?.message ?? `HTTP ${response.status}`;
    return new ServiceUnavailableError(`Email service rejected the message: ${message}`);
  }
}
