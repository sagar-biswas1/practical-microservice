import { z } from "zod";
import { env } from "../../config/env.js";

/**
 * The lifecycle states, mirrored from `prisma/schema.prisma`.
 *
 * Declared here as a plain tuple rather than imported from the generated
 * client so the request schemas — and the tests that exercise them — do not
 * depend on `prisma generate` having been run. `email.repository.ts` asserts
 * at compile time that the two definitions have not drifted apart.
 */
export const EMAIL_STATUSES = ["PENDING", "SENDING", "SENT", "FAILED", "DEAD"] as const;
export type EmailStatusValue = (typeof EMAIL_STATUSES)[number];

export const EMAIL_BODY_TYPES = ["TEXT", "HTML"] as const;
export type EmailBodyTypeValue = (typeof EMAIL_BODY_TYPES)[number];

/** Statuses a dispatcher may claim. */
export const CLAIMABLE_STATUSES = ["PENDING", "FAILED"] as const;

export const emailIdParamsSchema = z.object({
  id: z.uuid("Email id must be a valid UUID"),
});

/**
 * The send request.
 *
 * Every length here is the column width from `prisma/schema.prisma`, one for
 * one. Validating at the edge means an over-long subject is a 422 naming the
 * field, instead of a Postgres `value too long` surfacing as a 500 after the
 * request has already been accepted.
 */
export const sendEmailSchema = z.strictObject({
  // 320 octets is the RFC 5321 maximum for a full address. Lower-cased for the
  // same reason the user service does it: the same mailbox must not appear as
  // two different rows in the audit trail depending on who typed it.
  recipient: z
    .email("Must be a valid email address")
    .max(320, "Recipient address is too long")
    .transform((value) => value.toLowerCase()),

  subject: z.string().trim().min(1, "Subject is required").max(255),

  // Bounded by config rather than a literal: the cap is a policy decision that
  // differs between a transactional deployment and a newsletter one.
  body: z
    .string()
    .min(1, "Body is required")
    .max(env.EMAIL_MAX_BODY_CHARS, `Body must be at most ${env.EMAIL_MAX_BODY_CHARS} characters`),

  bodyType: z.enum(EMAIL_BODY_TYPES).default("TEXT"),

  /**
   * Who asked for this. A service name or an event name — `user-service`,
   * `order.confirmed`, `password-reset`. Constrained to a slug-ish shape so it
   * stays groupable: free text here degrades into a hundred spellings of the
   * same origin and the column stops being worth querying.
   */
  source: z
    .string()
    .trim()
    .min(1, "Source is required")
    .max(100)
    .regex(
      /^[a-z0-9][a-z0-9._-]*$/i,
      "Source may contain letters, digits, dots, underscores and hyphens only",
    ),
});

/**
 * Caller-supplied de-duplication token, read from the `Idempotency-Key`
 * header. Optional — a caller that omits it simply gets no replay protection,
 * which is the right default for `curl` but not for a retrying service.
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, "Idempotency-Key must be at least 8 characters")
  .max(255);

/** Listing filters. Every value arrives as a string, hence the coercions. */
export const listEmailsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(EMAIL_STATUSES).optional(),
  source: z.string().trim().min(1).max(100).optional(),
  recipient: z
    .email("recipient filter must be a valid email address")
    .max(320)
    .transform((value) => value.toLowerCase())
    .optional(),
});

export type SendEmailInput = z.infer<typeof sendEmailSchema>;
export type ListEmailsQuery = z.infer<typeof listEmailsQuerySchema>;
export type EmailIdParams = z.infer<typeof emailIdParamsSchema>;
