import { Router } from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import type { JsonObject } from "swagger-ui-express";
import { env } from "../config/env.js";
import { openapiDocument } from "./openapi.js";

export const DOCS_PATH = "/docs";
export const OPENAPI_PATH = "/openapi.json";

/**
 * Content-Security-Policy for the docs page only.
 *
 * Swagger UI bootstraps itself from an inline `<script>` and inline styles, so
 * the app-wide `helmet()` default — `script-src 'self'`, no inline — renders it
 * as a blank page. Rather than loosening the policy for the whole service, the
 * relaxed one is scoped to this router and the strict default keeps covering
 * every API route.
 *
 * `upgrade-insecure-requests` is deliberately absent: it would rewrite the
 * `http://localhost:*` URLs this page is served from in development.
 */
function docsSecurityHeaders(connectSrc: string[]) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'self'"],
        "object-src": ["'none'"],
        "img-src": ["'self'", "data:"],
        "font-src": ["'self'", "data:"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "connect-src": ["'self'", ...connectSrc],
      },
    },
    // The docs page is meant to be opened in a browser tab, not embedded, and
    // COEP would block nothing it actually loads.
    crossOriginEmbedderPolicy: false,
  });
}

export interface DocsRouterOptions {
  /** Extra origins the page may fetch — the servers "Try it out" can target. */
  connectSrc?: string[];
  /** Passed through to Swagger UI, e.g. a `urls` dropdown. */
  swaggerOptions?: Record<string, unknown>;
  document?: JsonObject;
}

/**
 * Serves the OpenAPI document and a Swagger UI over it.
 *
 * Mounted at the app root, ahead of the API router, so the docs live at
 * `/docs` rather than under the versioned prefix: they describe every version
 * the service speaks, and are not themselves part of the API contract.
 *
 * Returns an empty router when `DOCS_ENABLED` is false, so a deployment that
 * does not want its surface enumerated gets a 404 rather than a redirect or a
 * login page.
 */
export function createDocsRouter(options: DocsRouterOptions = {}): Router {
  const router = Router();
  if (!env.DOCS_ENABLED) return router;

  const document = options.document ?? (openapiDocument as JsonObject);

  // Applied per path, not with a bare `router.use`: this router is mounted at
  // the app root, so a path-less middleware here would hand the relaxed policy
  // to every API request that passes through on its way to the real routes.
  const securityHeaders = docsSecurityHeaders(options.connectSrc ?? []);

  router.get(OPENAPI_PATH, securityHeaders, (_req, res) => {
    res.json(document);
  });

  router.use(
    DOCS_PATH,
    securityHeaders,
    swaggerUi.serve,
    swaggerUi.setup(document, {
      customSiteTitle: `${env.SERVICE_NAME} API`,
      swaggerOptions: {
        // Survives a page reload, so a token pasted once keeps working.
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: "list",
        defaultModelsExpandDepth: 2,
        ...options.swaggerOptions,
      },
    }),
  );

  return router;
}
