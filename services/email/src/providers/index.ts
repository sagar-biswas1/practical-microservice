import { env, type EmailProviderName } from "../config/env.js";
import { ConsoleEmailProvider } from "./console.provider.js";
import { ResendProvider } from "./resend.provider.js";
import type { EmailProvider } from "./email-provider.js";

export type { EmailProvider, OutboundEmail, ProviderSendResult } from "./email-provider.js";
export { ProviderSendError, isRetryableStatus } from "./email-provider.js";
export { ConsoleEmailProvider } from "./console.provider.js";
export { ResendProvider } from "./resend.provider.js";

/**
 * Builds the configured provider.
 *
 * This function is the entire cost of changing mail vendors. `EMAIL_PROVIDER`
 * picks the implementation; a new one means a new file next to these two, a
 * member on the `EMAIL_PROVIDERS` tuple in `config/env.ts`, and a case below.
 * The switch is exhaustive over that tuple, so forgetting the case is a
 * compile error rather than a runtime surprise in production.
 */
export function createEmailProvider(
  name: EmailProviderName = env.EMAIL_PROVIDER,
): EmailProvider {
  switch (name) {
    case "resend":
      // Non-null assertion is safe: `config/env.ts` refuses to start the
      // process with EMAIL_PROVIDER=resend and no key.
      return new ResendProvider({
        apiKey: env.RESEND_API_KEY!,
        baseUrl: env.RESEND_BASE_URL,
        timeoutMs: env.EMAIL_PROVIDER_TIMEOUT_MS,
      });
    case "console":
      return new ConsoleEmailProvider();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unsupported EMAIL_PROVIDER: ${String(exhaustive)}`);
    }
  }
}
