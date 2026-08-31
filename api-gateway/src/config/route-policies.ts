import { authenticate, requireRole, Role } from "../middlewares/authenticate.js";
import { createStrictRateLimiter } from "../middlewares/rate-limit.js";
import type { RoutePolicy } from "../proxy/route-policy.js";
import { env } from "./env.js";
import type { ServiceName } from "./services.js";

/**
 * What the edge enforces, per nested route, before a request is proxied.
 *
 * Two rules shape every entry here:
 *
 * 1. **The gateway decides who you are; the service decides what you may do
 *    with its data.** The edge can prove a token is valid and read a role off
 *    it — that is pure computation on data it already holds. It cannot tell
 *    whether user `A` owns order `B` without asking the service that owns the
 *    answer, and an edge that starts making those calls stops being a router.
 *    So ownership checks are deliberately absent below; identity is forwarded
 *    as `x-actor-id` and the service does the rest.
 *
 * 2. **A route is public only if it has to be.** The policies are declared
 *    per-path rather than as a default-open list with exceptions, so a new
 *    upstream endpoint is unprotected only when someone writes it that way.
 *    The cost is that this table has to be updated when a service grows a
 *    route; that is the intended cost.
 */

/**
 * One shared bucket for every credential endpoint. Rotating between `/login`
 * and `/forgot-password` therefore draws on the same allowance — separate
 * limiters would hand an attacker a fresh budget per endpoint.
 */
const credentialRateLimiter = createStrictRateLimiter({
  name: "authentication",
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
});

/** `authenticate` then a role check, in the order they have to run. */
const adminOnly = [authenticate, requireRole(Role.ADMIN)];

export const routePolicies: Record<ServiceName, readonly RoutePolicy[]> = {
  /**
   * The auth service's own router splits public from authenticated at
   * `router.use(authenticate)`. This mirrors that split rather than inventing
   * a different one — where the two disagree, the service wins and the edge
   * has simply locked a door that was already locked.
   */
  auth: [
    {
      name: "credential-throttle",
      methods: ["POST"],
      // Everything that takes a secret, issues one, or can be used to probe
      // whether an account exists.
      paths: [
        "/register",
        "/login",
        "/refresh",
        "/forgot-password",
        "/reset-password",
        "/verify-email",
        "/resend-verification",
      ],
      handlers: [credentialRateLimiter],
    },
    {
      name: "authenticated-session",
      // `/logout` and `/refresh` are absent on purpose. Both authenticate with
      // the refresh token in the body, and both are needed precisely when the
      // access token has expired — requiring one here would make them useless
      // at the only moment they matter.
      paths: ["/me", "/sessions", "/logout-all", "/change-password", "/login-history"],
      handlers: [authenticate],
    },
  ],

  /**
   * The user service holds profiles keyed by the auth service's user id. Its
   * write and lookup endpoints exist for the auth service, which calls it
   * directly rather than through this edge — so nothing legitimate breaks by
   * closing them to public traffic.
   */
  user: [
    {
      name: "profile-provisioning",
      methods: ["POST"],
      // Profiles are created by the auth service during registration.
      // A client reaching this through the edge is doing something unusual.
      paths: ["/"],
      handlers: adminOnly,
    },
    {
      name: "auth-id-lookup",
      methods: ["GET"],
      // Resolving a profile from an auth user id is a service-to-service
      // shape; exposing it publicly turns auth ids into an enumeration handle.
      paths: ["/auth/:authUserId"],
      handlers: adminOnly,
    },
    {
      name: "profile-access",
      // Identity only. Whether this caller may read or edit *this* profile is
      // the user service's call — it is the one that knows the mapping.
      paths: ["/:id"],
      handlers: [authenticate],
    },
  ],

  /**
   * The catalogue is the one genuinely public surface in the system: reads are
   * open, writes are not.
   */
  product: [
    {
      name: "catalogue-writes",
      methods: ["POST", "PATCH", "PUT", "DELETE"],
      paths: ["/", "/:id"],
      handlers: adminOnly,
    },
  ],

  /**
   * Stock levels are operational data, not catalogue data — knowing that a SKU
   * is down to three units is a business fact, so even reads need a caller.
   *
   * The product service composes stock into its own responses by calling this
   * service directly, so the public product endpoints keep working unchanged.
   */
  inventory: [
    {
      name: "stock-visibility",
      methods: ["GET"],
      paths: ["/*"],
      handlers: [authenticate],
    },
    {
      name: "stock-mutations",
      methods: ["POST", "PATCH", "PUT", "DELETE"],
      // The collection, the item, and every stock transition below it. The
      // wildcard covers `/reserve`, `/release`, `/fulfil`, `/sell`, `/return`,
      // `/receive` and `/adjust` without naming them, so a new transition is
      // protected the day it ships rather than the day someone notices.
      paths: ["/", "/:id", "/:id/*"],
      handlers: adminOnly,
    },
  ],

  /**
   * Entirely an operations surface: the queue, its statistics, and a retry
   * button. Other services enqueue mail by calling it directly, so no
   * legitimate client-facing traffic passes through here at all.
   */
  email: [
    {
      name: "mail-operations",
      paths: ["/*"],
      handlers: adminOnly,
    },
  ],
};
