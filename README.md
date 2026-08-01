# practical-microservice

A pnpm workspace with two independent HTTP services built on TypeScript, Express 5, Prisma 6
(PostgreSQL), and Zod 4.

| Service     | Port   | Owns                                   | Base path                      |
| ----------- | ------ | -------------------------------------- | ------------------------------ |
| `product`   | `4001` | Product catalogue                      | `http://localhost:4001/api/v1` |
| `inventory` | `4002` | Stock levels + audited stock movements | `http://localhost:4002/api/v1` |

## Quick start

```bash
pnpm install

# Each service reads services/<name>/.env, falling back to the repo-root .env.
cp services/product/.env.example   services/product/.env
cp services/inventory/.env.example services/inventory/.env

pnpm db:generate     # generate both Prisma clients (required before typecheck/build)
pnpm db:migrate      # create tables — see "Database layout" first
pnpm dev             # run both services concurrently
```

Root scripts (`dev`, `build`, `start`, `test`, `typecheck`, `db:generate`, `db:migrate`,
`db:push`) fan out to every workspace package via `pnpm -r`. Run one service on its own with
`pnpm --filter @services/product <script>`.

## Database layout

Both services point at one PostgreSQL instance but own **separate Postgres schemas**, selected
by the `?schema=` parameter in each service's `DATABASE_URL`:

```
DATABASE_URL=postgresql://…/db?schema=product      # product service
DATABASE_URL=postgresql://…/db?schema=inventory    # inventory service
```

Neither service may read the other's tables. `inventory_items.product_id` is a *soft*
reference to the product service — deliberately not a foreign key, because consistency across
a service boundary is eventual, enforced by events and compensation rather than by the
database. Splitting onto two physical databases later means changing only the two URLs.

## Project structure

Each service is self-contained and follows the same layout. Nothing is shared at build time —
duplication across services is preferred over a shared package that would couple their release
cycles.

```
services/<name>/
├── prisma/schema.prisma        # data model — this service's tables only
├── src/
│   ├── server.ts               # entry point: composition root, listen, graceful shutdown
│   ├── app.ts                  # createApp(deps) — middleware stack, no I/O
│   ├── config/env.ts           # Zod-validated env; process exits on invalid config
│   ├── lib/
│   │   ├── logger.ts           # pino (pretty in dev, JSON elsewhere) + redaction
│   │   └── prisma.ts           # PrismaClient singleton + readiness probe
│   ├── errors/app-error.ts     # AppError hierarchy + machine-readable error codes
│   ├── middlewares/
│   │   ├── request-context.ts  # correlation id + request-scoped logger
│   │   ├── request-logger.ts   # morgan → pino, structured access logs
│   │   ├── validate.ts         # Zod validation → req.validated
│   │   ├── not-found-handler.ts
│   │   └── error-handler.ts    # terminal handler: everything → one JSON shape
│   ├── modules/<domain>/       # schema → repository → service → controller → routes
│   ├── routes/index.ts         # mounts the API under /api/v1
│   └── utils/                  # asyncHandler, response envelope helpers
└── tests/
    ├── unit/                   # domain rules and services, no HTTP
    ├── integration/            # full middleware stack via supertest
    └── helpers/                # in-memory repository fakes
```

## Architecture

**Read this first if you are new.** Both services have the same shape — learn one and you can
work in the other. Examples below use the inventory service; substitute `product` and the
files line up one for one.

### The one-paragraph version

An HTTP request enters `server.ts`, passes through a fixed middleware stack in `app.ts`, is
matched by a router, validated by Zod, and handed to a **controller**. The controller does no
thinking: it reads the validated input and calls a **service**. The service holds the business
rules and calls a **repository**. Only the repository knows Prisma exists. Anything that throws
along the way lands in one **error handler** that turns it into a single JSON shape. Each layer
only talks to the next one down.

### Layers

Every layer has one job and a hard rule about what it may not import. That rule is the whole
design — it is what keeps business logic testable and the database swappable.

| Layer          | Example file                    | Job                                          | Must never                        |
| -------------- | ------------------------------- | -------------------------------------------- | --------------------------------- |
| **Router**     | `inventory.routes.ts`           | Map method + path → validation → controller  | Contain logic of any kind         |
| **Validation** | `middlewares/validate.ts`       | Parse/coerce input with Zod, reject bad data | Know about any domain             |
| **Controller** | `inventory.controller.ts`       | HTTP in → service call → HTTP out            | Contain business rules; `try/catch` |
| **Service**    | `inventory.service.ts`          | Business rules, orchestration                | Import Express or Prisma          |
| **Rules**      | `inventory.rules.ts`            | Pure invariant checks and calculations       | Do any I/O                        |
| **Repository** | `inventory.repository.ts`       | Talk to the database                         | Contain business rules            |

Two consequences worth internalising:

- **The service never imports Prisma.** It depends on the `InventoryRepository` *interface*.
  That is precisely why the tests can pass an in-memory fake and run the entire HTTP stack
  with no database.
- **The controller never catches errors.** It lets them fly. `error-handler.ts` is the single
  place that decides what a failure looks like to a client, so no endpoint can invent its own
  error shape.

### Following one real request

`POST /api/v1/inventory/:id/reserve` — reserving stock for an order. Open these files in order
and you have seen the whole system:

```
1. server.ts              wires PrismaInventoryRepository → InventoryService → createApp()
2. app.ts                 helmet → cors → requestContext → requestLogger → express.json → router
3. routes/index.ts        mounts /api/v1, then /inventory
4. inventory.routes.ts    matches POST /:id/reserve
5. middlewares/validate.ts  Zod-parses params + body → req.validated  (bad input stops here, 422)
6. inventory.controller.ts  reads req.validated, calls service.reserve()
7. inventory.service.ts     builds a "planner" describing the intended change
8. inventory.repository.ts  opens a Serializable transaction, re-reads the row, runs the planner
9. inventory.rules.ts       planReservation() — throws ConflictError if it would oversell
10. inventory.repository.ts updates the item + writes a StockMovement, commits
11. utils/api-response.ts   wraps the result in { success: true, data: … }
```

If step 9 throws, steps 10–11 never happen; the error unwinds to `error-handler.ts`, which maps
`ConflictError` to `409` with the standard body. **You never write that error path yourself.**

Step 7→9 is the one genuinely subtle part. The service does not read the row, check it, then
write it — that would let two simultaneous reservations both read "90 available" and jointly
oversell. Instead it passes a *function* down to the repository, which runs it inside the
transaction against freshly-read data. The check and the write cannot be interleaved.

### Dependency injection

```
server.ts  ──creates──>  PrismaInventoryRepository  ──injected into──>  InventoryService
                                                                              │
                                                                     injected into
                                                                              ▼
                                                                       createApp(deps)
```

`server.ts` is the **only** file that names a concrete implementation. Everything else receives
what it needs through a constructor or a function argument. Tests call `createApp()` with an
`InMemoryInventoryRepository` instead, which is why `pnpm test` needs no database and finishes
in under a second.

Practical rule: `server.ts` is the only file that imports the `prisma` client itself. Even the
repository does not — it declares a `PrismaClient` constructor parameter and imports only the
*type*. If you find yourself reaching for the client anywhere else, the logic is in the wrong
layer.

### Where does my code go?

| You want to…                                   | Change this                                                |
| ---------------------------------------------- | ---------------------------------------------------------- |
| Add or change a database column                | `prisma/schema.prisma`, then `pnpm db:migrate`              |
| Change what input is accepted                  | `<domain>.schema.ts` (Zod)                                  |
| Add a business rule ("cannot X while Y")       | `<domain>.service.ts`, or `inventory.rules.ts` if it's pure |
| Change a database query                        | `<domain>.repository.ts`                                    |
| Add an endpoint                                | `<domain>.routes.ts` + controller (recipe below)            |
| Change the response envelope                   | `utils/api-response.ts`                                      |
| Add a new error type or status mapping         | `errors/app-error.ts`, `middlewares/error-handler.ts`       |
| Add something on every request (auth, metrics) | new file in `middlewares/`, registered in `app.ts`          |
| Add a config value                             | `config/env.ts` + both `.env.example` files                 |

### Recipe: adding an endpoint

Say you want `POST /inventory/:id/quarantine`:

1. **Schema** — add `quarantineSchema` to `inventory.schema.ts` and export its inferred type.
2. **Rules** — if there is an invariant, add a pure `planQuarantine()` to `inventory.rules.ts`
   and unit-test it. This is the cheapest place to get the logic right.
3. **Service** — add a `quarantine()` method that uses the rule.
4. **Repository** — only if you need a new query; stock changes already go through
   `applyStockChange`.
5. **Controller** — add a handler that reads `validated<QuarantineInput, unknown, IdParams>(req)`
   and returns via `sendSuccess`.
6. **Route** — wire it up: `router.post("/:id/quarantine", validate({ params, body }),
   asyncHandler(controller.quarantine))`.
7. **Tests** — a unit test for the rule, an integration test for the HTTP contract.

You do not touch `app.ts`, `error-handler.ts`, or `server.ts`. If a change forces you to, stop
and ask whether it belongs in a layer instead.

### Conventions that will bite you otherwise

- **Relative imports need a `.js` extension**, even in `.ts` files: `import { x } from
  "./thing.js"`. That is the ESM/NodeNext rule, not a typo — the extension refers to the
  compiled output.
- **Read input from `req.validated`, never `req.query` or `req.params`.** Express 5 makes those
  getter-only, so writing to them throws; `validate` puts parsed *and type-coerced* values on
  `req.validated`.
- **Throw `AppError` subclasses, never bare `Error`.** `new NotFoundError(...)` becomes a clean
  404; a bare `Error` becomes a generic 500 with the message hidden in production.
- **Bodies use `z.strictObject`**, so unknown fields are rejected rather than silently ignored.
- **Defaults belong only on create schemas.** `.partial()` does not strip `.default()`, so a
  shared base carrying defaults turns an empty `PATCH` into a silent overwrite.
- **No foreign keys across services.** `inventory_items.product_id` is just a UUID column.
- **Test the fake and the real implementation together.** If you add a method to a repository
  interface, update the in-memory fake in `tests/helpers/` or the build breaks — that is
  deliberate.

## API

### Product service (`:4001/api/v1`)

| Method   | Path            | Notes                                                  |
| -------- | --------------- | ------------------------------------------------------ |
| `GET`    | `/products`     | `page`, `limit`, `status`, `search`, `sortBy`, `order` |
| `POST`   | `/products`     | SKU and currency are normalised to upper case          |
| `GET`    | `/products/:id` |                                                        |
| `PATCH`  | `/products/:id` | Partial; an empty body is rejected                     |
| `DELETE` | `/products/:id` | `204`                                                  |

### Inventory service (`:4002/api/v1`)

| Method   | Path                       | Notes                                       |
| -------- | -------------------------- | ------------------------------------------- |
| `GET`    | `/inventory`               | `sku`, `productId`, `warehouse`, `lowStock` |
| `POST`   | `/inventory`               | One row per SKU                             |
| `GET`    | `/inventory/:id`           |                                             |
| `GET`    | `/inventory/sku/:sku`      | Lookup by SKU                               |
| `PATCH`  | `/inventory/:id`           | `warehouse` / `reorderLevel` only           |
| `DELETE` | `/inventory/:id`           | `409` while units are reserved              |
| `GET`    | `/inventory/:id/movements` | Audit trail, newest first                   |
| `POST`   | `/inventory/:id/reserve`   | Promise stock to an order                   |
| `POST`   | `/inventory/:id/release`   | Return a reservation to the pool            |
| `POST`   | `/inventory/:id/fulfil`    | Ship reserved units                         |
| `POST`   | `/inventory/:id/receive`   | Book in a delivery                          |
| `POST`   | `/inventory/:id/adjust`    | Signed correction; `reason` required        |

Stock transitions are `POST`s on sub-resources rather than `PATCH`es on a counter: each one is
a discrete, audited event that writes a `StockMovement` row.

**Invariants** (`src/modules/inventory/inventory.rules.ts`): `quantity >= 0`, `reserved >= 0`,
and `reserved <= quantity`. `available = quantity - reserved`. Reservations cannot oversell,
and a downward adjustment cannot cut into units already promised to an order. These checks run
*inside* a `Serializable` transaction against freshly-read state, so two concurrent
reservations cannot both read the same pre-change level and jointly oversell.

### Health endpoints

`GET /api/v1/health` and `/health/live` report process liveness (no I/O).
`GET /api/v1/health/ready` pings the database and returns `503` when it is unreachable — the
liveness/readiness split is what stops an orchestrator from restarting a healthy process just
because the database blipped.

## Response format

Success:

```json
{
  "success": true,
  "data": {},
  "meta": { "page": 1, "limit": 20, "total": 42, "totalPages": 3, "hasNextPage": true, "hasPreviousPage": false }
}
```

Errors always use one shape, whatever threw:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "field": "sku", "message": "SKU must be at least 3 characters" }],
    "requestId": "b5829533-3c3a-4e50-a5e5-4d40c51c69d6"
  }
}
```

Codes: `BAD_REQUEST`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`UNPROCESSABLE_ENTITY`, `TOO_MANY_REQUESTS`, `INTERNAL_SERVER_ERROR`, `SERVICE_UNAVAILABLE`.
Branch on `error.code`, never on the message. `stack` is included outside production only.

### Error handling

`src/middlewares/error-handler.ts` is the single exit path. It normalises `AppError`s,
`ZodError`s, Prisma errors (`P2002 → 409`, `P2025 → 404`, `P2003 → 409`, connection codes
`→ 503`), and body-parser failures (malformed JSON `→ 400`, oversized body `→ 413`). Anything
unrecognised becomes a `500` whose message is replaced in production, so internals never leak.

`AppError.isOperational` separates expected failures (bad input, missing row) from bugs:
operational errors log at `warn` and are surfaced verbatim; everything else logs at `error`
with a stack.

## Logging

pino, pretty-printed in development and JSON elsewhere, silent under test. Every request gets a
correlation id — taken from an inbound `x-request-id` when present so one id spans the whole
call chain — echoed in the response header and bound to `req.log`. Authorization headers,
cookies, passwords, tokens and `DATABASE_URL` are redacted. Morgan feeds structured access logs
into the same sink, at `warn` for 4xx and `error` for 5xx.

## Testing

```bash
pnpm test               # both services
pnpm test:watch
pnpm --filter @services/inventory test:coverage
```

Vitest + Supertest. **No database is required**: integration tests mount the real middleware
stack against in-memory repository fakes, so they cover routing, validation, the error handler
and the response envelope while staying fast and deterministic. Unit tests cover the domain
rules and services directly.

## Validation

Zod schemas live beside each module in `<domain>.schema.ts` and are applied per route by the
`validate` middleware. Parsed output goes to **`req.validated`**, never back onto `req.query`
or `req.params` — those are getter-only in Express 5, so assigning to them throws.

Request bodies use `z.strictObject`, so unknown fields are rejected rather than silently
dropped. Defaults (`currency`, `status`, `warehouse`) live only on the *create* schemas:
`.partial()` does not strip `.default()`, so a base schema carrying defaults would make an
empty `PATCH` body parse into real values and quietly overwrite columns.

## Configuration

`src/config/env.ts` validates the environment with Zod at import time and exits with a readable
report if anything is missing or malformed — the process fails at boot rather than at the first
request. See `.env.example` in each service for the full list.

## Deployment notes

- `pnpm build` compiles to `dist/`; `pnpm start` runs `node dist/server.js`.
- `SIGTERM`/`SIGINT` drain in-flight requests, then close the Prisma pool, with
  `SHUTDOWN_TIMEOUT_MS` as a backstop so a stuck connection cannot block a rolling deploy.
- `trust proxy` is enabled for accurate client IPs behind a gateway or ingress.
- `helmet` sets security headers; CORS origins come from `CORS_ORIGINS` (`*`, or a
  comma-separated allow-list).
