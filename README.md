# practical-microservice

A pnpm workspace with three independent HTTP services behind an edge gateway, built on
TypeScript, Express 5, Prisma 6 (PostgreSQL), and Zod 4.

| Package       | Port   | Owns                                   | Base path                      |
| ------------- | ------ | -------------------------------------- | ------------------------------ |
| `api-gateway` | `4000` | Single public entry point (stateless)  | `http://localhost:4000/api/v1` |
| `product`     | `4001` | Product catalogue                      | `http://localhost:4001/api/v1` |
| `inventory`   | `4002` | Stock levels + audited stock movements | `http://localhost:4002/api/v1` |
| `user`        | `4003` | User profiles keyed by an external login | `http://localhost:4003/api/v1` |

The product service calls the inventory service over HTTP — it provisions a stock record for
every product it creates and enriches its reads with stock levels. See
[Cross-service composition](#cross-service-composition). The inventory and user services call
nobody.

The user service is also where the [error-first convention](#error-first-results-user-service)
lives: its repository and service return `[error, data]` instead of throwing. It is the same
architecture as the other two with a different failure channel — read that section before
working in it.

Clients talk to the gateway, which forwards `/api/v1/products`, `/api/v1/inventory` and
`/api/v1/users` to the service that owns them. See [API gateway](#api-gateway). The services
still listen on their own ports, so they can be exercised directly in development.

## Quick start

```bash
pnpm install

# Each package reads its own .env, falling back to the repo-root .env.
cp services/product/.env.example   services/product/.env
cp services/inventory/.env.example services/inventory/.env
cp services/user/.env.example      services/user/.env
cp api-gateway/.env.example        api-gateway/.env

pnpm db:generate     # generate every Prisma client (required before typecheck/build)
pnpm db:migrate      # create tables — see "Database layout" first
pnpm dev             # run the gateway and all three services concurrently
```

Root scripts (`dev`, `build`, `start`, `test`, `typecheck`, `db:generate`, `db:migrate`,
`db:push`) fan out to every workspace package via `pnpm -r`. Run one package on its own with
`pnpm --filter @services/product <script>` or `pnpm --filter api-gateway <script>`.

## Database layout

The services point at one PostgreSQL instance but own **separate Postgres schemas**, selected
by the `?schema=` parameter in each service's `DATABASE_URL`:

```
DATABASE_URL=postgresql://…/db?schema=product      # product service
DATABASE_URL=postgresql://…/db?schema=inventory    # inventory service
DATABASE_URL=postgresql://…/db?schema=user         # user service
```

No service may read another's tables. `inventory_items.product_id` is a *soft*
reference to the product service — deliberately not a foreign key, because consistency across
a service boundary is eventual, enforced by compensation rather than by the database.
Splitting onto two physical databases later means changing only the two URLs.

**The reference points one way only.** `product_id` is `@unique` on `inventory_items`, and the
`products` table holds no inventory id. A second reference pointing back would make the two
rows mutually dependent — neither could be written first — and give one relationship two
sources of truth that can disagree. One direction also makes provisioning safe to retry: the
product id is all anyone needs to find, create, or repair the matching stock record.

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
│   ├── errors/
│   │   ├── app-error.ts        # AppError hierarchy + machine-readable error codes
│   │   └── normalize.ts        # anything thrown → AppError  (user service only)
│   ├── middlewares/
│   │   ├── request-context.ts  # correlation id + request-scoped logger
│   │   ├── request-logger.ts   # morgan → pino, structured access logs
│   │   ├── validate.ts         # Zod validation → req.validated
│   │   ├── not-found-handler.ts
│   │   └── error-handler.ts    # terminal handler: everything → one JSON shape
│   ├── clients/                # outbound calls to other services (product only)
│   ├── modules/<domain>/       # schema → repository → service → controller → routes
│   ├── routes/index.ts         # mounts the API under /api/v1
│   └── utils/                  # asyncHandler, response envelope helpers
│       └── result.ts           # [error, data] tuples             (user service only)
└── tests/
    ├── unit/                   # domain rules and services, no HTTP
    ├── integration/            # full middleware stack via supertest
    └── helpers/                # in-memory repository + service-client fakes
```

The gateway follows the same conventions — same env loading, logger, error envelope, and
correlation id — minus everything to do with persistence. It has no Prisma, no modules, and no
domain layer, because it owns no data:

```
api-gateway/
├── src/
│   ├── server.ts               # entry point: listen + graceful shutdown
│   ├── app.ts                  # createApp(deps) — middleware stack, no I/O
│   ├── config/
│   │   ├── env.ts              # Zod-validated env; process exits on invalid config
│   │   └── services.ts         # the routing table: prefix → upstream
│   ├── proxy/service-proxy.ts  # one reverse proxy per registry entry
│   ├── middlewares/
│   │   ├── rate-limit.ts       # per-IP throttle on proxied traffic
│   │   └── body-limit.ts       # Content-Length guard (bodies are never parsed)
│   └── modules/health/         # liveness + aggregated upstream readiness
└── tests/
    ├── unit/
    ├── integration/            # proxying verified against a real stub upstream
    └── helpers/
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
| **Client**     | `clients/inventory.client.ts`   | Talk to another *service* over HTTP           | Contain business rules            |

A **client** is the repository's mirror image: a repository is the boundary to a database, a
client is the boundary to someone else's API. Both are interfaces the service depends on, and
both have a fake in `tests/helpers/` — which is why the product service's tests need neither a
database nor a running inventory service.

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
10. inventory.repository.ts updates the item + writes a StockMovementHistory row, commits
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

The product service wires one more dependency the same way — its service takes a repository
*and* an inventory client:

```
server.ts  ──creates──>  PrismaProductRepository  ─┐
           ──creates──>  HttpInventoryClient  ─────┴──>  ProductService  ──>  createApp(deps)
```

`server.ts` is the **only** file that names a concrete implementation. Everything else receives
what it needs through a constructor or a function argument. Tests call `createApp()` with an
`InMemoryProductRepository` and a `FakeInventoryClient` instead, which is why `pnpm test` needs
no database, no running inventory service, and finishes in under a second.

Practical rule: `server.ts` is the only file that imports the `prisma` client itself. Even the
repository does not — it declares a `PrismaClient` constructor parameter and imports only the
*type*. If you find yourself reaching for the client anywhere else, the logic is in the wrong
layer.

### Error-first results (user service)

The product and inventory services signal failure by **throwing**: a service raises
`NotFoundError`, nothing catches it, and `error-handler.ts` turns it into a 404. The user
service does the same job with an **error-first return** instead — the Node-callback shape,
awaited:

```ts
type Ok<T>  = [error: null,     data: T];
type Err<E> = [error: E,        data: null];
type Result<T, E extends Error = AppError> = Ok<T> | Err<E>;
```

Every repository and service method in `services/user` returns one. The controller unpacks it
and hands any failure to Express:

```ts
const [error, user] = await this.service.getById(params.id);
if (error) return next(error);
sendSuccess(res, user);          // `user` is narrowed to User here, not User | null
```

That narrowing is the entire argument for the pattern. The tuple is a discriminated union, so
TypeScript refuses to give you `data` until `error` has been checked — **an unhandled failure
becomes a compile error rather than an exception discovered in production.** A thrown error is
invisible in a signature; this one is part of it.

Three rules keep it honest:

- **`null` data is not an error.** A lookup that finds nothing returns `[null, null]`. Absence
  is an ordinary answer, and only the service knows whether it means "404" or "good, that email
  is free". `[error, null]` is reserved for the store failing to answer at all — which is why
  `getById` on a downed database is a `503`, not a `404`.
- **Errors are always `AppError`s.** `utils/result.ts#attempt` wraps the one place that still
  throws — Prisma — and normalises whatever comes out via `errors/normalize.ts`. Nothing above
  the repository ever handles a raw Prisma type.
- **The tuple stops at the controller.** `next(error)` is Express's own error channel, so the
  same `error-handler.ts` renders it identically to a thrown one. The response envelope, the
  status mapping and the correlation id are unchanged; only the plumbing below differs.

`errors/normalize.ts` is the refactor that made this possible: `toAppError` used to live inside
the error middleware, where a repository could not reach it. In the user service it is a
plain, Express-free module that both the middleware and `attempt` import.

**The cost, stated plainly.** Every call site grows two lines, and a `return fail(error)` chain
replaces free propagation up the stack — an intermediate layer that has nothing to add still
has to forward the failure explicitly. That verbosity *is* the feature (nothing passes
silently), but it is a real trade, and it is why the two older services were left throwing
rather than converted. Pick one per service and stay consistent inside it.

### Cross-service composition

Stock lives in the inventory service, but callers want it next to the product. The product
service composes the two through `src/clients/inventory.client.ts` — a typed interface plus an
axios implementation, injected in `server.ts` exactly like a repository.

**Reads degrade, they do not fail.** `GET /products/:id` reports a `stockStatus`:

| Status           | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `IN_STOCK`       | `available > reorderLevel`                                            |
| `LOW_STOCK`      | `0 < available <= reorderLevel`                                       |
| `OUT_OF_STOCK`   | `available <= 0` — a real zero                                        |
| `UNPROVISIONED`  | Inventory answered and has no record for this product                 |
| `UNKNOWN`        | Inventory could not be reached                                        |

The last two are not states of the stock, and neither may be folded into `OUT_OF_STOCK`: that
turns an infrastructure problem into a business fact and stops you selling goods you hold. When
inventory is down the product still returns `200` with `stock: null`. A listing enriches the
whole page with **one** bulk call (`GET /inventory?productIds=…`), not one call per row.

**Writes are sagas, not transactions.** A database transaction is a property of one connection
to one database; the inventory write is an HTTP call to another process, and no `BEGIN` spans
those. Wrapping the call in `prisma.$transaction` would be strictly worse — it holds a
connection and its locks open for the duration of a remote call you do not control, and still
rolls back only the local half. So each write is ordered so the undoable step happens first,
with an explicit compensating call when the second step fails:

| Operation | Order                                              | If the second step fails                        |
| --------- | -------------------------------------------------- | ----------------------------------------------- |
| `create`  | product row → provision inventory                   | Delete the product; caller sees a clean failure |
| `update`  | inventory SKU → product row                         | Restore the previous inventory SKU              |
| `remove`  | guard on stock → delete product → delete inventory  | Log the orphan for reconciliation; call succeeds |

Compensation is best-effort by definition — the operation it is undoing has already failed, so
a failure there cannot be reported to the caller. It logs at `error` with both ids
(`product_rollback_failed`, `inventory_sku_rollback_failed`,
`orphaned_inventory_cleanup_failed`) for a reconciliation job to pick up. The residue is always
recoverable: a product with no stock record reads as `UNPROVISIONED` and can be re-provisioned
from its id alone.

The known gaps, stated plainly: there is no retry, no circuit breaker, and no idempotency key,
so a client retry after a timeout can provision twice — the `@unique` constraint on
`product_id` is what stops that becoming two stock records. A transactional outbox would close
the remaining window at the cost of making `POST /products` eventually consistent.

**Correlation and identity cross the boundary.** The client forwards `x-request-id` so one id
spans both services' logs, and `x-actor-id` so an inventory audit row records the real caller
rather than "unknown".

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
| Call another service                           | `clients/<service>.client.ts` + its fake in `tests/helpers/` |
| Change what stock a product exposes            | `product.service.ts` (`toProductView`, `toStockStatus`)      |

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
  404; a bare `Error` becomes a generic 500 with the message hidden in production. In the user
  service, `return fail(new NotFoundError(...))` instead — same classes, different channel; see
  [Error-first results](#error-first-results-user-service).
- **Bodies use `z.strictObject`**, so unknown fields are rejected rather than silently ignored.
- **Defaults belong only on create schemas.** `.partial()` does not strip `.default()`, so a
  shared base carrying defaults turns an empty `PATCH` into a silent overwrite.
- **No foreign keys across services.** `inventory_items.product_id` is just a UUID column.
- **Never put a network call inside a database transaction.** It holds the connection and its
  locks for the duration of a call you do not control, exhausts the pool under load, and buys
  no atomicity — the remote side commits regardless. Order the calls and compensate instead.
- **Cross-service references point one way.** Look stock up by `productId`; do not add an
  inventory id back onto the product.
- **Test the fake and the real implementation together.** If you add a method to a repository
  interface, update the in-memory fake in `tests/helpers/` or the build breaks — that is
  deliberate.

## API

### Product service (`:4001/api/v1`)

Every endpoint that returns a product body composes `stock` and `stockStatus` from the
inventory service; `DELETE` returns `204` with no body.

| Method   | Path            | Notes                                                                     |
| -------- | --------------- | ------------------------------------------------------------------------- |
| `GET`    | `/products`     | `page`, `limit`, `status`, `search`, `sortBy`, `order`; one bulk stock call |
| `POST`   | `/products`     | Also provisions the inventory record; SKU and currency upper-cased         |
| `GET`    | `/products/:id` |                                                                            |
| `PATCH`  | `/products/:id` | Partial; empty body rejected; a `sku` change is mirrored onto inventory    |
| `DELETE` | `/products/:id` | `204`; `409` while any stock or reservation remains                        |

`POST /products` takes an optional `stock` object for opening levels; omitted fields fall back
to inventory's own defaults. `inventoryId` is **not** accepted — the service owns that link:

```json
{
  "sku": "kbd-100",
  "name": "Mechanical Keyboard",
  "priceCents": 12999,
  "stock": { "quantity": 40, "reorderLevel": 5, "warehouse": "north" }
}
```

```json
{
  "success": true,
  "data": {
    "id": "…", "sku": "KBD-100", "status": "DRAFT",
    "stockStatus": "IN_STOCK",
    "stock": {
      "inventoryId": "…", "warehouse": "north",
      "quantity": 40, "reserved": 0, "available": 40, "reorderLevel": 5
    }
  }
}
```

Stock *levels* are not patchable here. They move through the inventory endpoints below, each of
which writes a ledger row; a second path into the same state would be a weaker one.

### Inventory service (`:4002/api/v1`)

| Method   | Path                        | Notes                                                        |
| -------- | --------------------------- | ------------------------------------------------------------ |
| `GET`    | `/inventory`                | `sku`, `productId`, `productIds` (CSV, bulk), `warehouse`, `lowStock` |
| `POST`   | `/inventory`                | One row per SKU **and** per `productId`                      |
| `GET`    | `/inventory/:id`            |                                                              |
| `GET`    | `/inventory/sku/:sku`       | Lookup by SKU                                                |
| `PATCH`  | `/inventory/:id`            | Any column except `reserved`; audited                        |
| `DELETE` | `/inventory/:id`            | `409` while units are reserved                               |
| `GET`    | `/inventory/:id/movements`  | Stock ledger, newest first; `?type=`                         |
| `GET`    | `/inventory/:id/audit-logs` | Field-change trail; `?field=`, `?actor=`                     |
| `POST`   | `/inventory/:id/reserve`    | Promise stock to an order                                    |
| `POST`   | `/inventory/:id/release`    | Return a reservation to the pool                             |
| `POST`   | `/inventory/:id/fulfil`     | Ship units that were reserved first                          |
| `POST`   | `/inventory/:id/sell`       | Sell without a prior reservation; `reference` required       |
| `POST`   | `/inventory/:id/receive`    | Book in a supplier delivery                                  |
| `POST`   | `/inventory/:id/return`     | Take back sold units; `reference` required                   |
| `POST`   | `/inventory/:id/adjust`     | Signed correction; `reason` required                         |

Stock transitions are `POST`s on sub-resources rather than `PATCH`es on a counter: each one is
a discrete, audited event that writes a `StockMovementHistory` row.

#### Two histories, kept apart

`stock_movement_histories` is a **ledger**: every row is a real movement, carrying
`quantityChanged`, the `lastQuantity` before it was applied, and a type:

| Type          | Written by            | Effect                                  |
| ------------- | --------------------- | --------------------------------------- |
| `INBOUND`     | `/receive`, create    | `quantity +`                            |
| `OUTBOUND`    | `/fulfil`, `/sell`    | `quantity −` (and `reserved −` on fulfil) |
| `RESERVATION` | `/reserve`            | `reserved +`                            |
| `RELEASE`     | `/release`            | `reserved −`                            |
| `RETURN`      | `/return`             | `quantity +`, kept distinct from a purchase |
| `ADJUSTMENT`  | `/adjust`, `PATCH`    | Signed correction                       |

`inventory_audit_logs` is a **field-change trail**: who changed which column, from what to
what. A `PATCH` writes one row per changed field, and a `quantity` edit additionally lands in
the ledger so the two never disagree about on-hand stock. A no-op patch writes nothing.

The actor comes from the `x-actor-id` header, set by the gateway and forwarded by the product
service; it is `null` when the caller is unattributed.

**Invariants** (`src/modules/inventory/inventory.rules.ts`): `quantity >= 0`, `reserved >= 0`,
and `reserved <= quantity`. `available = quantity - reserved`. Reservations cannot oversell, a
direct sale may only consume what is *available* rather than the full on-hand count, and
neither a downward adjustment nor a hand-edited `quantity` can cut into units already promised
to an order. These checks run
*inside* a `Serializable` transaction against freshly-read state, so two concurrent
reservations cannot both read the same pre-change level and jointly oversell.

### User service (`:4003/api/v1`)

Profiles for people who already exist somewhere else. This service owns the *profile*, not the
login: `authUserId` is a soft reference to whatever identity provider authenticated the caller,
deliberately not a foreign key, because that record lives outside this database.

| Method   | Path                      | Notes                                                       |
| -------- | ------------------------- | ----------------------------------------------------------- |
| `POST`   | `/users`                  | `409` on a duplicate `authUserId` or `email`                 |
| `GET`    | `/users/:id`              |                                                              |
| `GET`    | `/users/auth/:authUserId` | Resolve a login to its profile — the lookup other services use |
| `PATCH`  | `/users/:id`              | Partial; empty body rejected; `authUserId` is not patchable  |
| `DELETE` | `/users/:id`              | `204`; `404` for an unknown id                               |

`email` is lower-cased on the way in, because the column is unique and `A@x.com` and `a@x.com`
are the same mailbox — normalising at the schema keeps uniqueness from depending on who wrote
the query. `authUserId` is immutable once set: re-pointing a profile at a different login is an
account merge, with its own rules, not a field edit.

The uniqueness checks in the service are advisory. They exist to return a 409 naming the field;
the unique indexes on `auth_user_id` and `email` are what actually settle a race, and Prisma's
`P2002` normalises to the same 409, so the loser gets the same answer either way.

### Health endpoints

`GET /api/v1/health` and `/health/live` report process liveness (no I/O).
`GET /api/v1/health/ready` pings the database and returns `503` when it is unreachable — the
liveness/readiness split is what stops an orchestrator from restarting a healthy process just
because the database blipped.

## API gateway

One public entry point on `:4000`. It is a router, not a translator: gateway paths match
upstream paths exactly, so `POST :4000/api/v1/products` arrives at the product service as
`POST /api/v1/products`. Adding a service means adding an entry to `src/config/services.ts` —
proxying, readiness reporting, and the root banner all derive from that one table.

What it does at the edge, that no individual service should have to:

| Concern           | Behaviour                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| Routing           | `/products` → `:4001`, `/inventory` → `:4002`, `/users` → `:4003`, path-for-path |
| Correlation       | Mints `x-request-id` (honouring an inbound one) and forwards it upstream   |
| Identity          | Drops any client-supplied `x-actor-id` — see below                         |
| Rate limiting     | Per-IP, `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`, health exempt         |
| Upstream failures | `503` unreachable, `504` past `PROXY_TIMEOUT_MS`, `502` unusable reply     |
| Client IP         | `x-forwarded-*` added so upstreams see the real caller                     |

**The gateway never parses request bodies.** Parsing consumes the request stream the proxy has
to pipe upstream, so mounting `express.json()` here would leave every proxied `POST` hanging
with an empty payload. Only the declared `Content-Length` is checked, against `MAX_BODY_BYTES`;
the service that understands the payload does the precise rejecting.

**`x-actor-id` is stripped, not forwarded.** Downstream audit logs attribute writes to whatever
arrives in that header, and the gateway is the only hop that talks to untrusted clients — so an
inbound value is an unverified claim and is dropped. Nothing sets it yet, because there is no
authentication at this edge; that is where it will be set once there is. `TRUST_CLIENT_ACTOR=true`
passes the header through for local testing against services that expect an actor.

**Failures use the same envelope as everything else.** A proxy error surfaces in a raw `http`
callback rather than in Express, so `buildErrorBody` is shared between the two paths — a `504`
from a dead upstream looks exactly like a `422` from a Zod schema, correlation id included.

### Gateway health

`GET :4000/api/v1/health/live` reports process liveness only. `GET /health/ready` probes every
registered upstream concurrently and returns `503` when any is down, naming which and still
reporting the ones that are up:

```json
{
  "success": false,
  "error": { "code": "SERVICE_UNAVAILABLE", "details": [{ "field": "inventory", "message": "fetch failed" }] },
  "data": { "status": "degraded", "dependencies": { "product": { "status": "up", "latencyMs": 3 } } }
}
```

Liveness deliberately ignores the upstreams: a gateway whose dependencies are down is still a
healthy process, and restarting it would not help.

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
call chain — echoed in the response header and bound to `req.log`. An `x-actor-id` header, set
by the gateway once it has authenticated the caller, is exposed as `req.actor`, forwarded on
downstream calls, and stamped onto inventory audit rows. Authorization headers,
cookies, passwords, tokens and `DATABASE_URL` are redacted. Morgan feeds structured access logs
into the same sink, at `warn` for 4xx and `error` for 5xx.

## Testing

```bash
pnpm test               # every package
pnpm test:watch
pnpm --filter @services/inventory test:coverage
```

Vitest + Supertest. **No database and no running sibling service are required**: integration
tests mount the real middleware stack against in-memory repository fakes, so they cover
routing, validation, the error handler and the response envelope while staying fast and
deterministic. Unit tests cover the domain rules and services directly.

The product service's tests use two doubles — `InMemoryProductRepository` and
`FakeInventoryClient`. The fake client records every call it receives (method, and the
correlation context), and can be told to fail a chosen method, which is how the compensating
paths are tested without breaking anything real.

The HTTP client is covered separately in `tests/unit/inventory.client.test.ts`, against a
throwaway `node:http` server: envelope unwrapping, header propagation, `204`, `404 → null`,
status mapping, connection-refused and timeout. The fake proves the orchestration; only a real
socket proves the wire format.

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

Beyond the shared keys (`PORT`, `DATABASE_URL`, `LOG_LEVEL`, `CORS_ORIGINS`, `BODY_LIMIT`,
`SHUTDOWN_TIMEOUT_MS`), the product service adds:

| Variable                | Default                 | Purpose                                        |
| ----------------------- | ----------------------- | ---------------------------------------------- |
| `INVENTORY_SERVICE_URL` | `http://localhost:4002` | Base URL of the inventory service               |
| `INVENTORY_TIMEOUT_MS`  | `3000`                  | Per-request budget for inventory calls          |

Keep the timeout well under the gateway's `PROXY_TIMEOUT_MS`: a slow inventory service should
degrade product reads to `stockStatus: UNKNOWN`, not hold connections until the caller gives up.

The gateway has no `DATABASE_URL` or `BODY_LIMIT` — it is stateless and parses no bodies — and
adds:

| Variable                | Default                 | Purpose                                              |
| ----------------------- | ----------------------- | ---------------------------------------------------- |
| `PRODUCT_SERVICE_URL`   | `http://localhost:4001` | Upstream base URL                                    |
| `INVENTORY_SERVICE_URL` | `http://localhost:4002` | Upstream base URL                                    |
| `USER_SERVICE_URL`      | `http://localhost:4003` | Upstream base URL                                    |
| `PROXY_TIMEOUT_MS`      | `15000`                 | Upstream response budget before `504`                |
| `HEALTH_TIMEOUT_MS`     | `2000`                  | Budget for one readiness probe                       |
| `RATE_LIMIT_WINDOW_MS`  | `60000`                 | Throttle window                                      |
| `RATE_LIMIT_MAX`        | `300`                   | Requests per window, per IP, per replica             |
| `MAX_BODY_BYTES`        | `1048576`               | Largest `Content-Length` forwarded                   |
| `TRUST_CLIENT_ACTOR`    | `false`                 | Forward a client-supplied `x-actor-id` (testing only) |
| `TRUST_PROXY`           | `loopback`              | Whether `x-forwarded-for` is believed                |

`TRUST_PROXY` decides what `req.ip` resolves to, and `req.ip` is the rate limiter's key. It
defaults to `loopback` rather than `true` because trusting every hop lets any client forge
`x-forwarded-for` and hand itself a fresh bucket. Set it to the number of proxies actually in
front of the gateway (`1` behind a single ingress); leaving it too strict is the safe failure —
callers share a bucket rather than escaping one.

## Deployment notes

- `pnpm build` compiles to `dist/`; `pnpm start` runs `node dist/server.js`.
- `SIGTERM`/`SIGINT` drain in-flight requests, then close the Prisma pool, with
  `SHUTDOWN_TIMEOUT_MS` as a backstop so a stuck connection cannot block a rolling deploy.
- The services enable `trust proxy` for accurate client IPs behind the gateway or an ingress;
  the gateway scopes it via `TRUST_PROXY` because its rate limiter keys on `req.ip`.
- Only the gateway needs to be publicly reachable. The services should be bound to an internal
  network — nothing in them authenticates a caller, and `x-actor-id` is trusted on arrival.
- `helmet` sets security headers; CORS origins come from `CORS_ORIGINS` (`*`, or a
  comma-separated allow-list).
