# practical-microservice

A pnpm workspace of independent HTTP services behind an edge gateway, built on
TypeScript, Express 5, Prisma 6 (PostgreSQL), and Zod 4.

| Package       | Port   | Owns                                   | Base path                      |
| ------------- | ------ | -------------------------------------- | ------------------------------ |
| `api-gateway` | `4000` | Single public entry point (stateless)  | `http://localhost:4000/api/v1` |
| `product`     | `4001` | Product catalogue                      | `http://localhost:4001/api/v1` |
| `inventory`   | `4002` | Stock levels + audited stock movements | `http://localhost:4002/api/v1` |
| `user`        | `4003` | User profiles                          | `http://localhost:4003/api/v1` |
| `email`       | `4004` | Transactional outbox + mail delivery   | `http://localhost:4004/api/v1` |
| `auth`        | `4005` | Logins, sessions, verification codes   | `http://localhost:4005/api/v1` |

The product service calls the inventory service over HTTP — it provisions a stock record for
every product it creates and enriches its reads with stock levels. See
[Cross-service composition](#cross-service-composition). The inventory service calls nobody.

The auth service calls both the email service (to mail a verification code) and the user
service (to create the profile once an account verifies). Neither call happens inside a
database transaction, and neither is allowed to fail the request that triggered it — see
[services/auth/README.md](services/auth/README.md). The user and email services call nobody.

Clients talk to the gateway, which forwards every `/api/v1/*` path to the service that owns
it. See [API gateway](#api-gateway). The services still listen on their own ports, so they can
be exercised directly in development, and the service-to-service calls above go direct rather
than back out through the edge.

The gateway verifies access tokens itself and enforces a per-route policy in front of each
upstream — which routes need a token, which need `ADMIN`, which stay public. See
[Edge policies](#edge-policies).

## Quick start

```bash
pnpm install

# Each package reads its own .env, falling back to the repo-root .env.
cp services/product/.env.example   services/product/.env
cp services/inventory/.env.example services/inventory/.env
cp services/user/.env.example      services/user/.env
cp services/email/.env.example     services/email/.env
cp services/auth/.env.example      services/auth/.env
cp api-gateway/.env.example        api-gateway/.env

# The auth service and the gateway both refuse to boot without JWT_SECRET, and it
# has to be the same value: the gateway verifies the tokens the auth service signs.
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))" \
  | tee -a services/auth/.env >> api-gateway/.env

pnpm db:generate     # generate every Prisma client (required before typecheck/build)
pnpm db:migrate      # create tables — see "Database layout" first
pnpm dev             # run the gateway and every service concurrently
```

Root scripts (`dev`, `build`, `start`, `test`, `typecheck`, `db:generate`, `db:migrate`,
`db:push`) fan out to every workspace package via `pnpm -r`. Run one package on its own with
`pnpm --filter @services/product <script>` or `pnpm --filter api-gateway <script>`.

`argon2` — the auth service's password hasher — is a native module, so it is listed under
`onlyBuiltDependencies` in `pnpm-workspace.yaml`. Without that entry pnpm installs the package
but skips its install script, and the addon is missing at runtime rather than at install time.

Nothing forces you to run all six. The auth service degrades on purpose when its neighbours are
absent: registration answers `emailQueued: false` if the email service is unreachable, and
verification answers `profileCreated: false` if the user service is. Both are recoverable — by
a resend and by the next login respectively — so a partial stack is a normal way to work.

## Database layout

Every service points at one PostgreSQL instance but owns a **separate Postgres schema**,
selected by the `?schema=` parameter in its own `DATABASE_URL`:

```
DATABASE_URL=postgresql://…/db?schema=product      # product service
DATABASE_URL=postgresql://…/db?schema=inventory    # inventory service
DATABASE_URL=postgresql://…/db?schema=user         # user service
DATABASE_URL=postgresql://…/db?schema=email        # email service
DATABASE_URL=postgresql://…/db?schema=auth         # auth service
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

The identity side of the repo follows the same rule with one deliberate difference — the soft
reference is stored on **both** ends:

| Column                        | Points at            | Nullable | Why                                                     |
| ----------------------------- | -------------------- | -------- | ------------------------------------------------------- |
| `user."User"."authUserId"`    | `auth.auth_users.id` | no       | A profile without a login is not a thing that can exist  |
| `auth.auth_users.user_id`     | `user."User".id`     | **yes**  | A login without a profile is an ordinary, temporary state |

(The user service declares no `@map`/`@@map`, so its table and columns keep Prisma's
PascalCase/camelCase names and need quoting in SQL; `email` and `auth` map theirs to snake_case.
Worth reconciling one day — it is a rename plus a migration, not a design question.)

That is not the mutual dependency warned about above, because the two are not symmetric. The
user service's column is required and set at insert time — it is *how* a profile is created.
The auth service's is nullable and written afterwards, and its null is meaningful: it says the
profile hand-off has not succeeded yet. There is still one source of truth for the
relationship (the user service's row); `auth_users.user_id` is a cache of where to find it,
and the `@unique` on it is what stops a retry attaching a second profile to one login.

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
│   ├── clients/                # outbound calls to other services (product, auth)
│   ├── modules/<domain>/       # schema → repository → service → controller → routes
│   ├── routes/index.ts         # mounts the API under /api/v1
│   └── utils/                  # asyncHandler, response envelope helpers
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
│   │   ├── services.ts         # the routing table: prefix → upstream
│   │   └── route-policies.ts   # which nested routes need a token, or a role
│   ├── lib/tokens.ts           # access-token verification (no call to the auth service)
│   ├── proxy/
│   │   ├── service-proxy.ts    # one reverse proxy per registry entry
│   │   └── route-policy.ts     # path matcher + chain runner for the policies
│   ├── middlewares/
│   │   ├── authenticate.ts     # verifies the token, stamps x-actor-id, checks the role
│   │   ├── rate-limit.ts       # per-IP throttle, plus the credential-endpoint bucket
│   │   └── body-limit.ts       # Content-Length guard (bodies are never parsed)
│   └── modules/health/         # liveness + aggregated upstream readiness
└── tests/
    ├── unit/
    ├── integration/            # policies and proxying, against a real stub upstream
    └── helpers/
```

## Architecture

**Read this first if you are new.** Every service has the same shape — learn one and you can
work in any of them. Examples below use the inventory service; substitute `product`, `user`,
`email` or `auth` and the files line up one for one.

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

#### The identity half, which compensates forwards instead of backwards

The auth service makes two outbound calls, and neither uses the rollback strategy above. The
difference is worth understanding, because it is the same problem answered the other way round.

| Call                             | When                      | On failure                                      |
| -------------------------------- | ------------------------- | ----------------------------------------------- |
| `POST email-svc /emails`         | After registration commits | `emailQueued: false`; the user asks for a resend |
| `POST user-svc /users`           | After verification commits | `profileCreated: false`; the next login retries  |

`POST /products` rolls **back** when provisioning fails — it deletes the product, and the
caller sees a clean failure. Auth cannot do that. Undoing a registration because a *different*
service is down would throw away a password the user just chose, and undoing a verification
would mean telling someone who correctly entered their code that they had not. In both cases
the local write is the valuable one and the remote call is the follow-up, so the operation
commits and the gap is closed **forwards**: every login retries the profile hand-off, and every
`resend-verification` retries the mail.

That inverts which state is allowed to be temporarily wrong. Product/inventory tolerates no
product without stock and pays for it with a rollback; auth tolerates a verified account with
no profile and pays for it with a nullable column and a retry on the next request. Both are
sagas. Neither is a distributed transaction, because there is no such thing here.

A `409` from the user service is treated as **success**, not failure: it means an earlier
hand-off committed there but its response was lost. The profile exists, so auth looks it up by
`authUserId` and attaches the id it already should have had. This is the one place the
`GET /users/auth/:authUserId` endpoint earns its keep.

Auth also sends `Idempotency-Key: <verification id>` on every mail, so a retry after a timeout
returns the message the first attempt created rather than sending a second code. That is the
retry protection the product service is documented as lacking — the outbox is what makes it
available.

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
  404; a bare `Error` becomes a generic 500 with the message hidden in production.
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

Profiles only. This service holds no password, no session and no token — it does not know how
anyone authenticates, and that is the point of it being separate from `auth`.

| Method   | Path                      | Notes                                                        |
| -------- | ------------------------- | ------------------------------------------------------------ |
| `POST`   | `/users`                  | Called by the auth service once an account verifies           |
| `GET`    | `/users/auth/:authUserId` | Resolve a login to a profile — two segments, so `/:id` cannot shadow it |
| `GET`    | `/users/:id`              |                                                              |
| `PATCH`  | `/users/:id`              | Partial; empty body rejected; `authUserId` is **not** patchable |
| `DELETE` | `/users/:id`              | `204`                                                        |

`authUserId` is excluded from `PATCH` deliberately. Re-pointing a profile at a different login
is an account merge — an operation with its own rules about what happens to the orphaned side —
not a field edit, and allowing it here would make it look like one.

`GET /users/auth/:authUserId` exists because callers hold the *identity provider's* id, not
this service's. It is the lookup the auth service uses to recover from a hand-off whose
response was lost.

### Email service (`:4004/api/v1`)

A transactional outbox. `POST /emails` writes a row and commits; it does **not** send anything.
A background dispatcher claims due rows afterwards and makes the network call. Full rationale
in [services/email/README.md](services/email/README.md).

| Method | Path                | Notes                                                              |
| ------ | ------------------- | ------------------------------------------------------------------ |
| `POST` | `/emails`           | **`202`**, not `201` — accepted into the outbox, not delivered      |
| `GET`  | `/emails`           | `page`, `limit`, `status`, `source`, `recipient`                    |
| `GET`  | `/emails/stats`     | Queue depth by status — what a dashboard or alert rule watches      |
| `GET`  | `/emails/:id`       | How a caller finds out what happened to a message it enqueued       |
| `POST` | `/emails/:id/retry` | `202`; `FAILED` and `DEAD` only                                     |
| `POST` | `/emails/dispatch`  | Runs one dispatch cycle on demand; registered only when a dispatcher is wired in |

The `202` is the contract, and it is worth being blunt about why: at that moment the row is
committed and nothing more. Answering `201 Created` would be a claim about a mailbox this
service has not contacted yet, and callers act on that difference.

`Idempotency-Key` is optional but is what a *service* caller should always send. The key is
written in the same transaction as the message, so a caller that times out and retries gets the
original message back — answered `200` with an `Idempotent-Replay: true` header — instead of
mailing the recipient twice. Reusing one key for a **different** payload is a `409`, not a
silent replay: that combination is always a bug on the caller's side, and returning the first
message would hide it while dropping the second email.

```bash
curl -X POST localhost:4004/api/v1/emails \
  -H 'content-type: application/json' \
  -H 'idempotency-key: verify:9f3c…' \
  -d '{"recipient":"ada@example.com","subject":"Your code","body":"123456","source":"auth.email-verification"}'
```

`source` is slug-shaped (`auth.email-verification`, `order.confirmed`) rather than free text so
the column stays groupable — free text degrades into a hundred spellings of one origin and the
column stops being worth querying.

### Auth service (`:4005/api/v1`)

Logins, sessions and verification codes. Owns no profile — see
[services/auth/README.md](services/auth/README.md) for the full design.

| Method | Path                    | Auth          | Notes                                                     |
| ------ | ----------------------- | ------------- | --------------------------------------------------------- |
| `POST` | `/auth/register`        | —             | `201`. Body carries the profile the user service will need |
| `POST` | `/auth/verify-email`    | —             | `200` + tokens; creates the profile in the user service    |
| `POST` | `/auth/resend-verification` | —         | `202` **always** — see below                              |
| `POST` | `/auth/login`           | —             | `200` + tokens                                            |
| `POST` | `/auth/refresh`         | refresh token | Rotates; deliberately not behind the access-token guard    |
| `POST` | `/auth/logout`          | refresh token | `204`, idempotent                                         |
| `POST` | `/auth/forgot-password` | —             | `202` **always**                                          |
| `POST` | `/auth/reset-password`  | code          | Revokes every session                                     |
| `GET`  | `/auth/me`              | access token  |                                                           |
| `POST` | `/auth/change-password` | access token  | Requires the current password too                         |
| `GET`  | `/auth/sessions`        | access token  | Live sessions, current one flagged                        |
| `POST` | `/auth/logout-all`      | access token  |                                                           |
| `GET`  | `/auth/login-history`   | access token  | Paginated; `?outcome=`, `?success=`                       |

`/refresh` and `/logout` are authenticated by the refresh token in the body rather than by the
access-token guard. Requiring a valid access token would make them useless exactly when they
are needed — after that token has expired.

**Two token types, on purpose.** The access token is a signed JWT: verifying it is pure
computation, so any service can check it on every request without a database. The price is that
it cannot be revoked, so it lives 15 minutes. The refresh token is the opposite — an opaque
random string with no claims and no signature, useful only as a lookup key into
`refresh_tokens`. That is what makes it revocable, and revocation is why the *long-lived*
credential is the one with a row behind it.

**Rotation and reuse detection.** Every refresh mints a new token and kills the one presented.
So a **dead** token presented again means two copies were in circulation, and there is no way
to tell which one just called — the whole family is revoked and everyone signs in again.

```
login ──► T1 (family F)
          T1 ──refresh──► T2   T1 revoked ROTATED
          T2 ──refresh──► T3   T2 revoked ROTATED
          T1 ──refresh──► ✗    two copies existed
                               └─► every token in family F revoked REUSE_DETECTED
```

**The service never confirms whether an address has an account.** Login, resend and
forgot-password answer identically whether or not it exists — including in *timing*, which is
why a login for an unknown address still runs an argon2 hash before answering. An endpoint that
distinguishes them is a free membership oracle: point it at a leaked address list and it sorts
your users out of it. The client is told "invalid email or password" for every credential
failure while `login_history` records which it really was, because an operator investigating a
lockout needs the distinction and an attacker must not have it.

Registration is the one deliberate exception — a duplicate email is a `409`. The alternative
makes the sign-up form unusable for everyone who simply forgot they had an account.

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

| Concern           | Behaviour                                                                     |
| ----------------- | ----------------------------------------------------------------------------- |
| Routing           | `/auth` → `:4005`, `/users` → `:4003`, `/products` → `:4001`, `/inventory` → `:4002`, `/emails` → `:4004`, path-for-path |
| Correlation       | Mints `x-request-id` (honouring an inbound one) and forwards it upstream       |
| Authentication    | Verifies the access token on protected routes; `401` before the upstream is called |
| Authorisation     | Coarse role check (`ADMIN`) on writes and operational surfaces                 |
| Identity          | Sets `x-actor-id` from the verified token; drops any client-supplied one       |
| Rate limiting     | Per-IP, `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`, health exempt, plus a tighter shared bucket on the credential endpoints |
| Upstream failures | `503` unreachable, `504` past `PROXY_TIMEOUT_MS`, `502` unusable reply         |
| Client IP         | `x-forwarded-*` added so upstreams see the real caller                         |

**The gateway never parses request bodies.** Parsing consumes the request stream the proxy has
to pipe upstream, so mounting `express.json()` here would leave every proxied `POST` hanging
with an empty payload. Only the declared `Content-Length` is checked, against `MAX_BODY_BYTES`;
the service that understands the payload does the precise rejecting.

**`x-actor-id` is set from the token, never from the client.** Downstream audit logs attribute
writes to whatever arrives in that header, and the gateway is the only hop that talks to
untrusted clients — so an inbound value is an unverified claim and is deleted by
`requestContext` before anything can read it. On a route the edge authenticates, `authenticate`
then writes it back from the token's `sub`; sending a valid token for yourself alongside an
`x-actor-id` naming someone else gets you your own id, not theirs. `TRUST_CLIENT_ACTOR=true`
passes an inbound header through on the *unauthenticated* routes, for local testing against
services that expect an actor.

**Failures use the same envelope as everything else.** A proxy error surfaces in a raw `http`
callback rather than in Express, so `buildErrorBody` is shared between the two paths — a `504`
from a dead upstream looks exactly like a `422` from a Zod schema, correlation id included.

### Edge policies

Not every route behind the gateway should be reachable by everyone, and the interesting cases
are nested: `POST /api/v1/auth/login` is public while `GET /api/v1/auth/me` is not, and
`GET /api/v1/products` is public while `DELETE /api/v1/products/:id` is not. So middleware is
declared per path, in `src/config/route-policies.ts`, one block per upstream:

```ts
product: [
  {
    name: "catalogue-writes",
    methods: ["POST", "PATCH", "PUT", "DELETE"],
    paths: ["/", "/:id"],
    handlers: [authenticate, requireRole(Role.ADMIN)],
  },
],
```

`paths` are relative to the service's prefix. `:name` matches one segment, `/*` matches the
path and everything below it — `["/", "/:id", "/:id/*"]` is how every inventory stock
transition is covered without naming `reserve`, `release`, `fulfil` and the rest, so a
transition added next month is protected the day it ships.

The table is typed as a record over the registry's service names, so **adding an upstream does
not compile until its policy is declared** — even if the declaration is an empty array. "Which
routes need a token?" becomes a question you cannot skip.

| Prefix                | Public                                | Authenticated                                         | `ADMIN` only                              |
| --------------------- | ------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| `/api/v1/auth`        | register, login, refresh, logout, password reset, verification | `/me`, `/sessions`, `/logout-all`, `/change-password`, `/login-history` | — |
| `/api/v1/users`       | —                                     | `GET`/`PATCH`/`DELETE /:id`                            | `POST /`, `GET /auth/:authUserId`         |
| `/api/v1/products`    | all reads                             | —                                                     | create, update, delete                    |
| `/api/v1/inventory`   | —                                     | all reads                                             | writes and every stock transition         |
| `/api/v1/emails`      | —                                     | —                                                     | the entire surface                        |

`/logout` and `/refresh` stay public deliberately: both authenticate with the refresh token in
the body, and both are needed exactly when the access token has expired. Requiring one would
make them useless at the only moment they matter.

**The gateway decides who you are; the service decides what you may do with its data.** The
edge can prove a token is valid and read a role off it — pure computation on data it already
holds. It cannot tell whether user `A` owns profile `B` without asking the service that owns
the answer, and an edge that starts making those calls stops being a router. So there are no
ownership checks above: identity is forwarded as `x-actor-id` and the service does the rest.

**Verification is local, not a call to the auth service.** The gateway holds the same
`JWT_SECRET`, `JWT_ISSUER` and `JWT_AUDIENCE`, pins the algorithm to `HS256`, and verifies
signature/issuer/audience/expiry in microseconds. The cost is that it cannot see a revocation —
a suspended account still passes until its token expires, a window equal to
`ACCESS_TOKEN_TTL_MINUTES`. `JWT_SECRET` has no default and the gateway refuses to boot without
it: an optional secret would give the edge a mode where every policy silently degrades to "let
everything through", and a control that can be disabled by omission is not a control.

The services still verify the same token themselves. The edge is not a replacement for that —
it is what stops an unauthenticated request from ever opening a connection to an upstream, and
what makes a `401` look identical whichever service would have served it.

**Credential endpoints get a second, tighter budget.** Login, registration, refresh, password
reset and verification share one bucket of `AUTH_RATE_LIMIT_MAX` per `AUTH_RATE_LIMIT_WINDOW_MS`
(20 per 15 minutes by default) on top of the general limit. One bucket across all of them, so
rotating between `/login` and `/forgot-password` does not buy a fresh allowance.

**Why the policies match paths by hand.** The obvious spelling — `router.use("/auth/me", h)` —
does not work here. Express strips a mount prefix from `req.url`, and the proxy forwards
`req.url` unchanged, so mounting anything at a path would rewrite the request out from under
the proxy and send `/api/v1/auth/me` upstream as `/`. Every handler is therefore mounted at the
root and tests the full path itself (`src/proxy/route-policy.ts`), which keeps `req.url`
untouched and the matching small enough to unit test.

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

The auth service leans on the same idea hardest, because what is worth testing there is
*policy*: does a lockout actually lock, does a reused refresh token really cut the whole
family, do two different failures really produce byte-identical responses. None of that needs a
real Postgres to be wrong. Its `InMemoryAuthRepository` reproduces the concurrency guards the
Prisma one relies on — `status: PENDING` when consuming a code, `revokedAt: null` when rotating
a token — so those paths are exercised rather than assumed. `StubEmailClient` captures the mail
and exposes `codeFor(recipient)`, which is the only honest way to drive a verification flow end
to end: the plaintext code exists nowhere else by design, and a test that read it from the
database would be asserting a property the real system deliberately does not have.

Argon2 at production cost would dominate a suite containing dozens of logins, so
`tests/setup.ts` lowers the cost parameters. The hashing itself is covered separately in
`tests/unit/crypto.test.ts`, which also pins the JWT behaviour that matters: a tampered payload
is rejected, an `alg: none` token is rejected, and every failure mode returns the same message.

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

The **user service** adds nothing — the shared keys are its whole configuration. That is a fair
summary of the service: it stores profiles and talks to no one.

The **email service** adds a provider, message limits, and the dispatcher:

| Variable                      | Default                   | Purpose                                              |
| ----------------------------- | ------------------------- | ---------------------------------------------------- |
| `EMAIL_PROVIDER`              | `console`                 | `console` or `resend`; adding one is a case in `providers/index.ts` |
| `EMAIL_FROM`                  | `onboarding@resend.dev`   | Sender; Resend rejects an unverified domain           |
| `RESEND_API_KEY`              | —                         | Required when `EMAIL_PROVIDER=resend`                 |
| `EMAIL_MAX_BODY_CHARS`        | `100000`                  | Body cap, enforced in the schema so it is a `422`     |
| `EMAIL_MAX_ATTEMPTS`          | `5`                       | Copied onto each row at enqueue time                  |
| `DISPATCHER_ENABLED`          | `true`                    | `false` runs the API as a pure writer; `pnpm dispatch` separately |
| `DISPATCHER_POLL_INTERVAL_MS` | `5000`                    | Claim cycle period                                    |
| `DISPATCHER_BATCH_SIZE`       | `25`                      | Rows per cycle, so one worker cannot starve the rest   |
| `DISPATCHER_CONCURRENCY`      | `5`                       | Sends in flight within a batch                        |
| `DISPATCHER_CLAIM_TIMEOUT_MS` | `120000`                  | How long a claim is honoured before the row is reclaimed |
| `RETRY_BACKOFF_BASE_MS`       | `2000`                    | Doubles per attempt, plus jitter                      |
| `RETRY_BACKOFF_MAX_MS`        | `900000`                  | Backoff ceiling                                       |
| `EMAIL_RETENTION_DAYS`        | `30`                      | Purge `SENT` rows; `0` disables                       |

`DISPATCHER_CLAIM_TIMEOUT_MS` must exceed `EMAIL_PROVIDER_TIMEOUT_MS`, and the env schema
refuses to boot if it does not: a claim that expires while a send is still in flight lets a
second worker pick the row up and deliver the same message twice.

The **auth service** adds signing keys, hashing cost, and the two upstreams:

| Variable                       | Default                 | Purpose                                              |
| ------------------------------ | ----------------------- | ---------------------------------------------------- |
| `JWT_SECRET`                   | **none — required**     | HS256 signing key, minimum 32 characters              |
| `JWT_ISSUER` / `JWT_AUDIENCE`  | `auth-service` / `practical-microservice` | Written to `iss`/`aud` and checked on every verify |
| `ACCESS_TOKEN_TTL_MINUTES`     | `15`                    | Exactly how long a stolen access token keeps working  |
| `REFRESH_TOKEN_TTL_DAYS`       | `30`                    | Session lifetime without a refresh                    |
| `ARGON2_MEMORY_COST_KIB`       | `19456`                 | OWASP's second recommended argon2id configuration     |
| `ARGON2_TIME_COST`             | `2`                     |                                                       |
| `ARGON2_PARALLELISM`           | `1`                     |                                                       |
| `PASSWORD_MIN_LENGTH`          | `10`                    | Length is the control that matters (NIST SP 800-63B)  |
| `PASSWORD_MAX_LENGTH`          | `128`                   | Bounds hashing cost — an unbounded field is a DoS     |
| `VERIFICATION_CODE_TTL_MINUTES`| `15`                    |                                                       |
| `VERIFICATION_MAX_ATTEMPTS`    | `5`                     | Wrong guesses before the code is burned               |
| `VERIFICATION_RESEND_COOLDOWN_SECONDS` | `60`            | Without it, "resend" is an open mail relay            |
| `MAX_FAILED_LOGIN_ATTEMPTS`    | `5`                     |                                                       |
| `ACCOUNT_LOCK_DURATION_MINUTES`| `15`                    | Time-bounded, not permanent — see below               |
| `EMAIL_SERVICE_URL`            | `http://localhost:4004` | Where verification mail is enqueued                   |
| `USER_SERVICE_URL`             | `http://localhost:4003` | Where the profile is created                          |
| `EMAIL_TIMEOUT_MS` / `USER_TIMEOUT_MS` | `3000`          | Per-request budget for each                           |
| `APP_NAME`                     | `Practical Microservice`| Product name in outbound mail                         |

`JWT_SECRET` has no default in any environment, including development, and the service exits at
boot without it. A fallback here would be the most dangerous line in the repo: a deploy that
forgot to set it would come up healthy and sign real tokens with a key published on GitHub.

Argon2's cost parameters are encoded inside every digest it produces, so raising them later
needs no migration and no re-hash — existing passwords keep verifying under the settings they
were made with, and each is upgraded the next time its owner changes it.

`ACCOUNT_LOCK_DURATION_MINUTES` expires on purpose. A lock only an operator can clear hands
anyone who knows an email address a way to lock its owner out on demand.

The gateway has no `DATABASE_URL` or `BODY_LIMIT` — it is stateless and parses no bodies — and
adds:

| Variable                    | Default                 | Purpose                                               |
| --------------------------- | ----------------------- | ----------------------------------------------------- |
| `PRODUCT_SERVICE_URL`       | `http://localhost:4001` | Upstream base URL                                     |
| `INVENTORY_SERVICE_URL`     | `http://localhost:4002` | Upstream base URL                                     |
| `USER_SERVICE_URL`          | `http://localhost:4003` | Upstream base URL                                     |
| `EMAIL_SERVICE_URL`         | `http://localhost:4004` | Upstream base URL                                     |
| `AUTH_SERVICE_URL`          | `http://localhost:4005` | Upstream base URL                                     |
| `JWT_SECRET`                | *(none — required)*     | Must match the auth service byte for byte             |
| `JWT_ISSUER`                | `auth-service`          | Must match the auth service                           |
| `JWT_AUDIENCE`              | `practical-microservice`| Must match the auth service                           |
| `PROXY_TIMEOUT_MS`          | `15000`                 | Upstream response budget before `504`                 |
| `HEALTH_TIMEOUT_MS`         | `2000`                  | Budget for one readiness probe                        |
| `RATE_LIMIT_WINDOW_MS`      | `60000`                 | Throttle window                                       |
| `RATE_LIMIT_MAX`            | `300`                   | Requests per window, per IP, per replica              |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `900000`                | Window for the shared credential-endpoint bucket      |
| `AUTH_RATE_LIMIT_MAX`       | `20`                    | Credential requests per window, per IP, per replica   |
| `MAX_BODY_BYTES`            | `1048576`               | Largest `Content-Length` forwarded                    |
| `TRUST_CLIENT_ACTOR`        | `false`                 | Forward a client-supplied `x-actor-id` on unauthenticated routes (testing only) |
| `TRUST_PROXY`               | `loopback`              | Whether `x-forwarded-for` is believed                 |

`JWT_SECRET` has no default here either, for the same reason it has none in the auth service —
and it must be the *same* value. A mismatch does not fail loudly: every token simply looks
forged, and the whole system answers `401`.

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
  network — `x-actor-id` is trusted on arrival, so anything that can reach them can claim to be
  anyone. The auth service is a partial exception: its `/me`, `/sessions`, `/logout-all`,
  `/login-history` and `/change-password` routes verify a real signed token. Every other
  service still authenticates nobody.
- `helmet` sets security headers; CORS origins come from `CORS_ORIGINS` (`*`, or a
  comma-separated allow-list).
- **`JWT_SECRET` must differ per environment.** `iss`/`aud` are checked on every verification,
  so a staging token is rejected in production even if the key leaked across — but that is a
  second line of defence, not a reason to share one.
- `argon2` is a native module. Build and run on the same platform, or make sure the image's
  install step can fetch a prebuilt binary for the target architecture.
- The email dispatcher can run inside the API process (`DISPATCHER_ENABLED=true`, the default)
  or as its own deployment (`pnpm --filter @services/email dispatch`). Both use the same claim
  query, so they can also run side by side — which is what makes moving delivery out of the API
  a deployment decision rather than a code change.
