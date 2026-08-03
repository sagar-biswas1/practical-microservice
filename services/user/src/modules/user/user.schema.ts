import { z } from "zod";

export const userIdParamsSchema = z.object({
  id: z.uuid("User id must be a valid UUID"),
});

/**
 * `authUserId` comes from the identity provider, so its format is not ours to
 * dictate — it is length-checked only.
 */
export const authUserIdParamsSchema = z.object({
  authUserId: z.string().trim().min(1, "authUserId is required").max(191),
});

/**
 * Field definitions without defaults.
 *
 * Defaults live only on the create schema: `.partial()` does NOT strip them,
 * so a base carrying `.default()` would make an empty PATCH body parse into a
 * populated object and quietly reset those columns.
 */
const userFieldsSchema = z.strictObject({
  authUserId: z.string().trim().min(1, "authUserId is required").max(191),
  name: z.string().trim().min(1, "Name is required").max(150),
  // Lower-cased on the way in: the column is unique, and `A@x.com` and
  // `a@x.com` are the same mailbox. Normalising here rather than at each call
  // site keeps uniqueness from depending on who wrote the query.
  email: z
    .email("Must be a valid email address")
    .max(150)
    .transform((value) => value.toLowerCase()),
  address: z.string().trim().min(1, "Address is required").max(250),
  phone: z
    .string()
    .trim()
    .min(7, "Phone number is too short")
    .max(20)
    .regex(/^\+?[0-9][0-9\s().-]*$/, "Phone number contains unsupported characters"),
});

/**
 * `id` is deliberately absent: the database mints it, and a client-supplied
 * one could collide with an existing profile.
 */
export const createUserSchema = userFieldsSchema;

/**
 * Every field optional, but reject a no-op patch so an empty body can't
 * masquerade as a successful update.
 *
 * `authUserId` is not patchable. It is the caller's key into the identity
 * provider, and re-pointing a profile at a different login is an account
 * merge — a deliberate operation with its own rules, not a field edit.
 */
export const updateUserSchema = userFieldsSchema
  .omit({ authUserId: true })
  .partial()
  .refine((data) => Object.values(data).some((value) => value !== undefined), {
    message: "At least one field must be provided",
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UserIdParams = z.infer<typeof userIdParamsSchema>;
export type AuthUserIdParams = z.infer<typeof authUserIdParamsSchema>;
