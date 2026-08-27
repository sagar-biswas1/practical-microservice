import axios, { type AxiosInstance } from "axios";
import { fail, ok, type Result } from "../utils/result.js";
import {
  isRetryableStatus,
  ProviderSendError,
  type EmailProvider,
  type OutboundEmail,
  type ProviderSendResult,
} from "./email-provider.js";

/**
 * Shape of Resend's `POST /emails` success body.
 * @see https://resend.com/docs/api-reference/emails/send-email
 */
interface ResendSendResponse {
  id: string;
}

/** Resend reports failures as `{ statusCode, name, message }`. */
interface ResendErrorResponse {
  statusCode?: number;
  name?: string;
  message?: string;
}

export interface ResendProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to an axios instance built from the above. */
  client?: AxiosInstance;
}

/**
 * Resend adapter, written against their REST API directly rather than the
 * `resend` SDK.
 *
 * Two reasons: `axios` is already a dependency of every service here, so this
 * adds no new supply-chain surface; and going direct keeps the timeout, the
 * idempotency header and the error classification explicit rather than
 * inherited from a client whose retry behaviour would overlap with the
 * dispatcher's own. If you would rather use the SDK, this is the only file
 * that has to change.
 */
export class ResendProvider implements EmailProvider {
  readonly name = "resend";

  private readonly client: AxiosInstance;

  constructor(options: ResendProviderOptions) {
    this.client =
      options.client ??
      axios.create({
        baseURL: options.baseUrl ?? "https://api.resend.com",
        timeout: options.timeoutMs ?? 10_000,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        // Statuses are classified below rather than by axios, so no status is
        // allowed to throw on its own.
        validateStatus: () => true,
      });
  }

  async send(message: OutboundEmail): Promise<Result<ProviderSendResult, ProviderSendError>> {
    const payload = {
      from: message.from,
      to: [message.to],
      subject: message.subject,
      ...(message.bodyType === "HTML" ? { html: message.body } : { text: message.body }),
    };

    let response;
    try {
      response = await this.client.post<ResendSendResponse & ResendErrorResponse>(
        "/emails",
        payload,
        {
          // Resend de-duplicates on this key for 24 hours. Paired with the row
          // id it means a redelivery after a timeout cannot double-send: we do
          // not know whether the first attempt landed, and this makes it not
          // matter.
          headers: { "Idempotency-Key": message.id },
        },
      );
    } catch (error) {
      // No response at all — DNS failure, connection reset, or our own
      // timeout firing. The request may well have been processed, which is
      // exactly why the idempotency key above is not optional.
      return fail(
        new ProviderSendError(
          `Resend request failed: ${error instanceof Error ? error.message : "unknown error"}`,
          { retryable: true, cause: error },
        ),
      );
    }

    if (response.status >= 200 && response.status < 300 && response.data?.id) {
      return ok({ provider: this.name, providerMessageId: response.data.id });
    }

    const detail = response.data?.message ?? response.data?.name ?? response.statusText;

    return fail(
      new ProviderSendError(`Resend rejected the message (${response.status}): ${detail}`, {
        retryable: isRetryableStatus(response.status),
        providerStatus: response.status,
      }),
    );
  }
}
