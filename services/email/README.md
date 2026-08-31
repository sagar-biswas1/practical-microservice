# Email service

Accepts email send requests, stores them, and delivers them through a pluggable
provider. Resend is the provider that ships; swapping it is one new file.

Port `4004`, owns the `email` Postgres schema, error-first (`[error, data]`)
throughout — same conventions as `services/user`.

## Why it is built this way

The obvious version of this service calls the mail provider inside the request
handler. That version has a bug that only shows up in production: the caller's
database write and the provider's HTTP call are two independent systems, and
there is no way to make them succeed or fail together. Commit first and the
process can die before the send. Send first and the commit can fail after the
email has already gone out. Wrap the send in the transaction and one slow
upstream holds a database connection open until the pool is empty.

So the service does not send email during a request. It writes a row and
commits — one system, one transaction, atomic by definition. A background
**dispatcher** picks the row up afterwards and performs the network call. That
is the transactional outbox pattern, and `email_messages` is the outbox.

The cost is that delivery is **at-least-once**, not exactly-once: a worker can
be killed between the provider accepting a message and the row being marked
`SENT`, after which the row is reclaimed and sent again. That window is closed
at the provider instead — the row id travels as the provider-side idempotency
key, so the duplicate is de-duplicated there rather than landing in an inbox.

```
POST /emails ──► BEGIN                                  (no network call here)
                   INSERT email_messages   status=PENDING
                   INSERT idempotency_keys
                 COMMIT
             ──► 202 Accepted

dispatcher  ──► claim due rows      PENDING/FAILED → SENDING, attempts += 1
            ──► provider.send(…)    Idempotency-Key: <row id>
            ──► SENT | FAILED (backoff) | DEAD
```

## Lifecycle

```
PENDING ──► SENDING ──► SENT
                   └──► FAILED ──► SENDING ──► …      (retryable, backed off)
                   └──► DEAD                          (permanent, or out of attempts)
```

`DEAD` is the dead-letter state. Two ways in:

- **Attempts exhausted** — the provider kept failing transiently.
- **Permanent rejection** — a malformed address, an unverified sender domain.
  Retrying a refusal the provider will simply repeat spends the whole backoff
  schedule to arrive at the same answer, and delays an operator noticing. The
  provider adapter classifies this (`ProviderSendError.retryable`).

`POST /emails/:id/retry` returns a `FAILED` or `DEAD` row to `PENDING`. It
refuses `SENT` (the recipient already has it) and `SENDING` (a worker is
holding it).

## Table

`email_messages` — the fields you asked for, plus what the outbox needs to work.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | Also the provider-side idempotency key |
| `recipient` | `varchar(320)` | RFC 5321 maximum; lower-cased on the way in |
| `subject` | `varchar(255)` | |
| `body` | `text` | Capped by `EMAIL_MAX_BODY_CHARS` in the request schema, not by the column — an HTML body runs long, and a column cap surfaces as a 500 rather than a 422 |
| `bodyType` | `TEXT \| HTML` | Defaults to `TEXT` |
| `source` | `varchar(100)` | Who asked: `user-service`, `order.confirmed`. Slug-shaped so it stays groupable |
| `status` | enum | `PENDING \| SENDING \| SENT \| FAILED \| DEAD` |
| `attempts` / `maxAttempts` | `int` | Ceiling copied from config at enqueue time, so raising the default later can't revive rows already declared dead |
| `nextAttemptAt` | `timestamptz` | Backoff is a stored timestamp, not a sleep, so a restart can't lose it |
| `lockedAt` / `lockedBy` | | The claim. A `SENDING` row locked longer than `DISPATCHER_CLAIM_TIMEOUT_MS` is treated as orphaned and reclaimed |
| `lastError` | `varchar(1000)` | Truncated — a breadcrumb, not a log sink |
| `provider` / `providerMessageId` | | The receipt, per row: the provider can be swapped while messages are in flight |
| `sentAt`, `createdAt`, `updatedAt` | | |

Indexed on `(status, nextAttemptAt)`. A single-column index on `status` would
be close to useless — almost every row ends up `SENT`, so the column has
terrible cardinality and Postgres falls back to a sequential scan as the table
grows.

`idempotency_keys` maps a caller-supplied key to the message it produced, plus
a SHA-256 of the payload. Written in the same transaction as the message.

## Idempotency

Send `Idempotency-Key` on `POST /emails`:

- **Same key, same payload** → `200` with the original message and
  `Idempotent-Replay: true`. No second email.
- **Same key, different payload** → `409`. Always a caller-side bug; replaying
  silently would drop the second email without telling anyone.
- **No key** → no replay protection. Fine for `curl`, not for a service that
  retries on timeout.

## API

All paths under `/api/v1`.

| Method | Path | |
| --- | --- | --- |
| `POST` | `/emails` | Enqueue. `202` accepted, `200` on replay. Not `201` — the row is committed, the email is not sent |
| `GET` | `/emails` | List. Filters: `status`, `source`, `recipient`; `page`, `limit` (max 100) |
| `GET` | `/emails/stats` | Outbox depth by status — the number to alert on |
| `GET` | `/emails/:id` | One message, with its status and last error |
| `POST` | `/emails/:id/retry` | Requeue a `FAILED`/`DEAD` message |
| `POST` | `/emails/dispatch` | Run one dispatch cycle. Registered only when a dispatcher is wired in |
| `GET` | `/health`, `/health/live`, `/health/ready` | |

```bash
curl -X POST localhost:4004/api/v1/emails \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: welcome-user-42' \
  -d '{"recipient":"delivered@resend.dev","subject":"Welcome","body":"Hello","source":"user-service"}'
```

## Changing provider

`EmailProvider` (`src/providers/email-provider.ts`) is the seam:

```ts
interface EmailProvider {
  readonly name: string;
  send(message: OutboundEmail): Promise<Result<ProviderSendResult, ProviderSendError>>;
}
```

To add one: write the adapter next to `resend.provider.ts`, add its name to
`EMAIL_PROVIDERS` in `config/env.ts`, add a case to `createEmailProvider`. The
switch is exhaustive over that tuple, so a missing case is a compile error.
Nothing else in the service names a provider — not the routes, not the service
layer, not the schema.

Two ship today: `resend` (needs `RESEND_API_KEY`) and `console`, which logs
instead of sending. `console` is the default so a fresh clone runs end to end
with no credentials and no risk of mailing real people from a half-configured
account.

The Resend adapter talks to the REST API through `axios` rather than the
`resend` SDK — `axios` is already a dependency of every service here, and going
direct keeps the timeout, the idempotency header and the retryable/permanent
classification explicit rather than inherited from a client whose own retry
behaviour would overlap with the dispatcher's. Switching to the SDK means
editing that one file.

## Running the dispatcher

In-process by default, alongside the API. Set `DISPATCHER_ENABLED=false` and
run `pnpm --filter @services/email dispatch` to separate accepting mail from
sending it — worth doing once traffic justifies it, since a short database
write and a call that waits on a third party scale very differently.

Any number of workers can run at once. Claiming is a guarded state transition:
workers may select the same candidates, but the `UPDATE` carries the original
predicate, so the loser re-evaluates after the winner commits, finds the row
already `SENDING`, and takes nothing. (`SELECT … FOR UPDATE SKIP LOCKED` avoids
the momentary block and is the better choice at high throughput; it needs
`$queryRaw`, which would put the claim logic out of reach of the in-memory
repository the tests run against.)

Retries use exponential backoff **with jitter** — 2s, 4s, 8s, … capped at
`RETRY_BACKOFF_MAX_MS`. The jitter is not decoration: without it every message
that failed during one outage shares a `nextAttemptAt`, and they all hit the
provider in the same instant the moment it recovers.

`SENT` rows older than `EMAIL_RETENTION_DAYS` are purged hourly. An outbox is a
queue, not an archive; left alone it accumulates millions of rows and the claim
index degrades with it. `DEAD` rows are never purged — they are the record of
what never arrived.

## Setup

```bash
cp services/email/.env.example services/email/.env   # then set DATABASE_URL
pnpm --filter @services/email db:generate
pnpm --filter @services/email db:migrate             # creates the tables
pnpm --filter @services/email dev
```

## Tests

`pnpm --filter @services/email test` — 90 tests, no database and no network.
The in-memory repository reimplements the claim protocol rather than stubbing
it, because exclusivity, orphan recovery and the attempt increment are
properties of the transition rules, not of Postgres. A mocked `claimDue`
returning a fixed array would prove none of them.
