import { env } from "./env.js";

/**
 * Version prefix the gateway exposes. It matches the prefix each upstream
 * mounts, which is what lets requests be forwarded path-for-path with no
 * rewriting — the gateway stays a router, not a translator.
 */
export const API_PREFIX = "/api/v1";

/**
 * Registry keys, as a closed set rather than a bare `string`.
 *
 * The point is the policy table in `config/route-policies.ts`: it is typed as
 * a record over this union, so adding a service here fails to compile until
 * its edge policy has been declared. "Which routes need a token?" becomes a
 * question you cannot forget to answer.
 */
export type ServiceName = "auth" | "user" | "product" | "inventory" | "email";

export interface ServiceRoute {
  /** Registry key. Appears in logs and in the `/health/ready` payload. */
  name: ServiceName;
  /**
   * Path prefix owned by this upstream. Every request whose path starts with
   * it is forwarded verbatim, so `${prefix}` must resolve to the same route on
   * both sides.
   */
  prefix: string;
  /** Absolute base URL of the upstream, without a trailing slash. */
  target: string;
  /** Liveness probe path, relative to `target`, used by readiness checks. */
  healthPath: string;
}

/**
 * The routing table. Adding a service to the gateway means adding an entry
 * here — proxying, readiness reporting, and the root banner all derive from it.
 *
 * Order is match order. `auth` sits first because it is the only upstream
 * whose availability every other route depends on; nothing else about the
 * ordering matters, since the prefixes are disjoint.
 */
export const serviceRegistry: readonly ServiceRoute[] = [
  {
    name: "auth",
    prefix: `${API_PREFIX}/auth`,
    target: env.AUTH_SERVICE_URL,
    healthPath: `${API_PREFIX}/health/live`,
  },
  {
    name: "user",
    prefix: `${API_PREFIX}/users`,
    target: env.USER_SERVICE_URL,
    healthPath: `${API_PREFIX}/health/live`,
  },
  {
    name: "product",
    prefix: `${API_PREFIX}/products`,
    target: env.PRODUCT_SERVICE_URL,
    healthPath: `${API_PREFIX}/health/live`,
  },
  {
    name: "inventory",
    prefix: `${API_PREFIX}/inventory`,
    target: env.INVENTORY_SERVICE_URL,
    healthPath: `${API_PREFIX}/health/live`,
  },
  {
    name: "email",
    prefix: `${API_PREFIX}/emails`,
    target: env.EMAIL_SERVICE_URL,
    healthPath: `${API_PREFIX}/health/live`,
  },
];
