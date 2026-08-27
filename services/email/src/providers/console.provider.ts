import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import { ok, type Result } from "../utils/result.js";
import type {
  EmailProvider,
  OutboundEmail,
  ProviderSendError,
  ProviderSendResult,
} from "./email-provider.js";

/**
 * Writes the message to the log instead of sending it.
 *
 * The default provider, so a fresh clone runs end to end with no credentials
 * and no risk of mailing a real person from a half-configured account. It also
 * doubles as the proof that the abstraction is real: the dispatcher, the
 * outbox and every test path work identically whichever implementation is
 * installed.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(message: OutboundEmail): Promise<Result<ProviderSendResult, ProviderSendError>> {
    logger.info(
      {
        emailId: message.id,
        to: message.to,
        from: message.from,
        subject: message.subject,
        bodyType: message.bodyType,
        bodyChars: message.body.length,
      },
      "email_console_delivery",
    );

    return ok({ provider: this.name, providerMessageId: `console-${randomUUID()}` });
  }
}
