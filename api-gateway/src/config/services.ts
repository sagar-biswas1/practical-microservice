import { env } from "./env.js";

/**
 * Version prefix the gateway exposes. It matches the prefix each upstream
 * mounts, which is what lets requests be forwarded path-for-path with no
 * rewriting — the gateway stays a router, not a translator.
 */
export const API_PREFIX = "/api/v1";

export interface ServiceRoute {
  /** Registry key. Appears in logs and in the `/health/ready` payload. */
  name: string;
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
 */
export const serviceRegistry: readonly ServiceRoute[] = [
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
];
