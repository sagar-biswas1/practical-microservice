import { z } from "zod";
import { env } from "../../config/env.js";
import { CODE_LENGTH } from "../../utils/codes.js";

/**
 * Enum values mirrored from `prisma/schema.prisma`.
 *
 * Declared as plain tuples rather than imported from the generated client so
 * the request schemas — and the tests that exercise them — do not depend on
 * `prisma generate` having been run. `auth.repository.ts` asserts at compile
 * time that the two definitions have not drifted apart.
 */
export const ROLES = ["USER", "ADMIN"] as const;
export type RoleValue = (typeof ROLES)[number];

export const AUTH_USER_STATUSES = ["ACTIVE", "SUSPENDED", "DELETED"] as const;
export type AuthUserStatusValue = (typeof AUTH_USER_STATUSES)[number];

export const VERIFICATION_TYPES = [
  "EMAIL_VERIFICATION",
  "PASSWORD_RESET",
  "EMAIL_CHANGE",
] as const;
export type VerificationTypeValue = (typeof VERIFICATION_TYPES)[number];

export const VERIFICATION_STATUSES = ["PENDING", "VERIFIED", "EXPIRED", "REVOKED"] as const;
export type VerificationStatusValue = (typeof VERIFICATION_STATUSES)[number];

export const LOGIN_OUTCOMES = [
  "SUCCESS",
  "INVALID_CREDENTIALS",
  "UNKNOWN_EMAIL",
  "NOT_VERIFIED",
  "ACCOUNT_LOCKED",
  "ACCOUNT_INACTIVE",
] as const;
export type LoginOutcomeValue = (typeof LOGIN_OUTCOMES)[number];

export const REVOKE_REASONS = [
  "ROTATED",
  "LOGOUT",
  "LOGOUT_ALL",
  "PASSWORD_CHANGED",
  "REUSE_DETECTED",
] as const;
export type RevokeReasonValue = (typeof REVOKE_REASONS)[number];

// ---- Field primitives -------------------------------------------------------

/**
 * Lower-cased on the way in. The column is unique, and `A@x.com` and `a@x.com`
 * are the same mailbox — normalising here rather than at each call site keeps
 * uniqueness from depending on who wrote the query. 320 octets is the RFC 5321
 * maximum for a full address.
 */
const emailField = z
  .email("Must be a valid email address")
  .max(320, "Email address is too long")
  .transform((value) => value.toLowerCase());

/**
 * Also lower-cased, so `Ada` and `ada` cannot both be registered. The character
 * set is deliberately narrow: a username that may contain `@` is
 * indistinguishable from an email address at a login form, and one that may
 * contain whitespace or unicode look-alikes invites impersonation.
 */
const usernameField = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(50, "Username must be at most 50 characters")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "Username may contain letters, digits, dots, underscores and hyphens only",
  )
  .transform((value) => value.toLowerCase());

/**
 * A handful of passwords account for a wildly disproportionate share of real
 * account compromises. This is not a substitute for a breach-corpus check
 * (Have I Been Pwned's k-anonymity API is the real answer) — it is the cheap
 * offline approximation, and it is here so the *shape* of the check exists at
 * the right layer when someone swaps in the real one.
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "passw0rd",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "qwerty123",
  "letmein123",
  "iloveyou1",
  "admin123",
  "welcome123",
  "changeme",
  "secret123",
]);

/**
 * Length is the control that matters — NIST SP 800-63B explicitly recommends
 * *against* composition rules, which mostly produce `Password1!` and a sticky
 * note. So: a floor, a ceiling, and a blocklist.
 *
 * The ceiling is not cosmetic. Argon2 hashes whatever it is given, so an
 * unbounded password field is an unbounded amount of CPU and memory per login
 * attempt — a denial-of-service vector dressed as generosity.
 */
const passwordField = z
  .string()
  .min(
    env.PASSWORD_MIN_LENGTH,
    `Password must be at least ${env.PASSWORD_MIN_LENGTH} characters`,
  )
  .max(
    env.PASSWORD_MAX_LENGTH,
    `Password must be at most ${env.PASSWORD_MAX_LENGTH} characters`,
  )
  .refine(
    (value) => !COMMON_PASSWORDS.has(value.toLowerCase()),
    "This password is too common — choose something less predictable",
  );

/** The six digits from the email. Kept as a string: `007123` is not a number. */
const codeField = z
  .string()
  .trim()
  .length(CODE_LENGTH, `Code must be exactly ${CODE_LENGTH} digits`)
  .regex(/^\d+$/, "Code must be digits only");

/**
 * The opaque refresh token. Only bounded, never parsed — it has no structure
 * to validate, and pretending otherwise would couple the schema to how
 * `createRefreshToken` happens to encode its bytes today.
 */
const refreshTokenField = z
  .string()
  .trim()
  .min(20, "Refresh token is malformed")
  .max(512, "Refresh token is malformed");

/**
 * Profile fields belonging to the *user* service, collected here at
 * registration and held until the account verifies.
 *
 * Validated against that service's constraints so a mismatch is a 422 at
 * registration — while the user is still on the form — rather than a failed
 * hand-off fifteen minutes later, when the account is already verified and
 * there is no one left to correct it.
 */
export const profileSchema = z.strictObject({
  name: z.string().trim().min(1, "Name is required").max(150),
  address: z.string().trim().min(1, "Address is required").max(250),
  phone: z
    .string()
    .trim()
    .min(7, "Phone number is too short")
    .max(20)
    .regex(/^\+?[0-9][0-9\s().-]*$/, "Phone number contains unsupported characters"),
});

export type PendingProfile = z.infer<typeof profileSchema>;

// ---- Request schemas --------------------------------------------------------

export const registerSchema = z
  .strictObject({
    email: emailField,
    username: usernameField,
    password: passwordField,
    profile: profileSchema,
  })
  .superRefine((value, ctx) => {
    // A password containing the account's own identifiers is the first thing
    // any credential-stuffing list tries. Checked here rather than inside
    // `passwordField` because it needs the sibling fields.
    const password = value.password.toLowerCase();
    const localPart = value.email.split("@")[0] ?? "";

    if (password.includes(value.username) || (localPart && password.includes(localPart))) {
      ctx.addIssue({
        code: "custom",
        path: ["password"],
        message: "Password must not contain your username or email address",
      });
    }
  });

export const verifyEmailSchema = z.strictObject({
  email: emailField,
  code: codeField,
});

export const resendVerificationSchema = z.strictObject({
  email: emailField,
});

export const loginSchema = z.strictObject({
  email: emailField,
  /**
   * Bounded but otherwise unvalidated. Applying the password *policy* to a
   * login would reject an existing account whose password predates a rule
   * change — with a 422 that helpfully explains what their password looks
   * like. The only thing that decides a login is the hash comparison.
   */
  password: z.string().min(1, "Password is required").max(env.PASSWORD_MAX_LENGTH),
});

export const refreshSchema = z.strictObject({
  refreshToken: refreshTokenField,
});

export const logoutSchema = z.strictObject({
  refreshToken: refreshTokenField,
});

export const forgotPasswordSchema = z.strictObject({
  email: emailField,
});

export const resetPasswordSchema = z.strictObject({
  email: emailField,
  code: codeField,
  password: passwordField,
});

export const changePasswordSchema = z
  .strictObject({
    currentPassword: z.string().min(1, "Current password is required").max(env.PASSWORD_MAX_LENGTH),
    password: passwordField,
  })
  .refine((value) => value.currentPassword !== value.password, {
    path: ["password"],
    message: "New password must differ from the current one",
  });

/** Listing filters for login history. Every value arrives as a string. */
export const loginHistoryQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  success: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  outcome: z.enum(LOGIN_OUTCOMES).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type LoginHistoryQuery = z.infer<typeof loginHistoryQuerySchema>;
