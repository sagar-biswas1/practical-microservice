import { env } from "../../config/env.js";
import type { EnqueueEmailInput } from "../../clients/email.client.js";

/**
 * The mail this service asks the email service to send.
 *
 * Plain text, and deliberately so. These are the messages that carry the
 * credentials to take over an account, and every feature an HTML mail could
 * add — a tracking pixel, a remote image, a styled "click here" button that
 * hides where it points — is a feature a phisher benefits from more than the
 * user does. A six-digit code the user types back into a page they navigated
 * to themselves cannot be redirected anywhere.
 *
 * Rendering lives here rather than in the email service because the *content*
 * is this service's business; delivery is theirs. The email service knows how
 * to retry an SMTP failure and nothing about what a verification code is.
 */

const ttlMinutes = env.VERIFICATION_CODE_TTL_MINUTES;

/** `source` values, so mail can be grouped by flow in the email service. */
export const EMAIL_SOURCES = {
  verification: "auth.email-verification",
  passwordReset: "auth.password-reset",
  passwordChanged: "auth.password-changed",
} as const;

export function verificationEmail(recipient: string, code: string): EnqueueEmailInput {
  return {
    recipient,
    subject: `${env.APP_NAME}: your verification code is ${code}`,
    body: [
      `Welcome to ${env.APP_NAME}.`,
      "",
      "Enter this code to finish setting up your account:",
      "",
      `    ${code}`,
      "",
      `The code expires in ${ttlMinutes} minutes and can be used once.`,
      "",
      "If you did not create this account, you can ignore this message —",
      "nothing was set up and the address will not be contacted again.",
    ].join("\n"),
    bodyType: "TEXT",
    source: EMAIL_SOURCES.verification,
  };
}

export function passwordResetEmail(recipient: string, code: string): EnqueueEmailInput {
  return {
    recipient,
    subject: `${env.APP_NAME}: your password reset code is ${code}`,
    body: [
      `Someone asked to reset the password for your ${env.APP_NAME} account.`,
      "",
      "Enter this code to choose a new one:",
      "",
      `    ${code}`,
      "",
      `The code expires in ${ttlMinutes} minutes and can be used once.`,
      "",
      "If this was not you, ignore this message. Your password has not been",
      "changed, and it will not change unless this code is used.",
    ].join("\n"),
    bodyType: "TEXT",
    source: EMAIL_SOURCES.passwordReset,
  };
}

/**
 * Sent after the fact, and worth sending even though nothing in it is
 * actionable: it is how someone whose account was taken over finds out. A
 * password change the owner did not make is the first signal they get, and
 * they only get it if the notice goes to the address on file.
 */
export function passwordChangedEmail(recipient: string): EnqueueEmailInput {
  return {
    recipient,
    subject: `${env.APP_NAME}: your password was changed`,
    body: [
      `The password for your ${env.APP_NAME} account was just changed.`,
      "",
      "Every device that was signed in has been signed out.",
      "",
      "If this was not you, reset your password immediately — whoever made",
      "this change still knows the address of this mailbox.",
    ].join("\n"),
    bodyType: "TEXT",
    source: EMAIL_SOURCES.passwordChanged,
  };
}
