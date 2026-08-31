import { Router } from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import type { JsonObject } from "swagger-ui-express";
import { env } from "../config/env.js";
import { serviceRegistry } from "../config/services.js";
import { openapiDocument } from "./openapi.js";

export const DOCS_PATH = "/docs";
export const OPENAPI_PATH = "/openapi.json";

/** Where each upstream publishes its own document. */
interface Definition {
  name: string;
  url: string;
}

/**
 * The definition picker's contents: this gateway first, then every upstream.
 *
 * The upstream URLs are the ones from the routing table, which are resolved by
 * *this process*. The picker is fetched by the browser, so a deployment whose
 * upstreams are not reachable from the client's network gets a working gateway
 * spec and a failing dropdown — which is the honest outcome, since in that
 * deployment those documents genuinely are not browsable from there.
 */
export function definitions(): Definition[] {
  return [
    { name: `${env.SERVICE_NAME} (this gateway)`, url: OPENAPI_PATH },
    ...serviceRegistry.map(({ name, target }) => ({
      name: `${name} service`,
      url: `${target}${OPENAPI_PATH}`,
    })),
  ];
}

/**
 * Content-Security-Policy for the docs page only.
 *
 * Swagger UI bootstraps from an inline `<script>` and inline styles, so the
 * app-wide `helmet()` default renders it as a blank page. The relaxed policy is
 * scoped to this router rather than loosened globally, and `connect-src` is
 * widened to exactly the upstream origins the picker fetches from — nothing
 * else.
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
    crossOriginEmbedderPolicy: false,
  });
}

/**
 * Serves the gateway's own OpenAPI document, and a Swagger UI whose definition
 * picker also covers every upstream.
 *
 * One page for the whole system is the point: the gateway forwards paths
 * verbatim, so an endpoint documented by the product service is reachable at
 * that same path here, and a reader should not have to know which port owns it
 * to go and look.
 *
 * Returns an empty router when `DOCS_ENABLED` is false.
 */
export function createDocsRouter(): Router {
  const router = Router();
  if (!env.DOCS_ENABLED) return router;

  const document = openapiDocument as JsonObject;
  const sources = definitions();

  // Applied per path, not with a bare `router.use`: this router is mounted at
  // the app root, so a path-less middleware here would hand the relaxed policy
  // to every proxied request passing through on its way to an upstream.
  const securityHeaders = docsSecurityHeaders(serviceRegistry.map(({ target }) => target));

  router.get(OPENAPI_PATH, securityHeaders, (_req, res) => {
    res.json(document);
  });

  router.use(
    DOCS_PATH,
    securityHeaders,
    swaggerUi.serve,
    // `null`, not the document: passing a spec inline would pin the page to it
    // and the picker below would have nothing to switch between.
    swaggerUi.setup(null, {
      customSiteTitle: `${env.SERVICE_NAME} API`,
      explorer: true,
      swaggerOptions: {
        urls: sources,
        "urls.primaryName": sources[0]?.name,
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: "list",
        defaultModelsExpandDepth: 2,
      },
    }),
  );

  return router;
}
