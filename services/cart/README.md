<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

The cart service: shopper carts in Redis, with stock held in the inventory
service for as long as a cart lives and handed back when it expires.

## Talking to other services

Two kinds of call leave this service, and they travel differently.

**Request/response** — reserving stock, moving a hold to an order at checkout,
looking up stock levels. A shopper is waiting on the answer, so these go over
HTTP to the inventory service (`INVENTORY_SERVICE_URL`) and always will. They
live behind `INVENTORY_PORT` in `src/inventory/inventory.port.ts`.

**Fire-and-forget** — releasing stock when a cart expires, is abandoned, or a
checkout falls through. Nobody is waiting, so these live behind a second port,
`INVENTORY_DISPATCH`, whose transport is a config value:

| `INVENTORY_DISPATCH_TRANSPORT` | What happens on a release                                          |
| ------------------------------ | ------------------------------------------------------------------ |
| `http` (default)               | `POST /api/v1/inventory/bulk/release`, same as everything else     |
| `amqp`                         | A message on RabbitMQ, confirmed by the broker before we move on   |

Splitting the two into separate interfaces is what makes the switch safe: a
transport cannot make a reservation fire-and-forget, because the method is not
on the interface it implements.

### RabbitMQ

`src/messaging/` owns the connection. `RabbitMqClient` is this service's one
connection to the broker as a publisher — a single confirm channel, shared by
every adapter that publishes. It promises three things:

1. `publish` resolves only once the broker has **confirmed** the message. A
   resolved promise is the caller's licence to delete its own record of what
   was sent (the cart), so resolving on a mere socket write would turn a
   broker hiccup into stock that is reserved forever.
2. `publish` never hangs: it resolves or rejects with `BrokerUnavailableError`
   within `RABBITMQ_PUBLISH_TIMEOUT_MS`. The inventory adapter turns that into
   `ServiceUnavailableException`, the same error a failed HTTP call raises, so
   the cart's sweeper retries the release exactly as it does today.
3. Topology registered through `registerTopology` exists on the broker before
   the first publish and is declared again after every reconnect.

Connection loss is handled once, here: the first connection at boot is allowed
to fail the process (a wrong URL surfaces at bootstrap, as with Redis); every
later loss is retried forever with a capped backoff, and publishes issued in
the meantime wait for the reconnect rather than failing straight away.

Setting `RABBITMQ_URL` turns the module on. Unset, nothing here opens a socket
and `GET /api/v1/health/ready` reports `broker: { enabled: false }`. The broker is
reported by readiness but does not gate it — losing it only delays releases,
which the sweeper retries.

```bash
pnpm rabbitmq:up                        # from the repo root; UI at :15672, guest/guest
echo 'RABBITMQ_URL=amqp://guest:guest@localhost:5672' >> .env
echo 'INVENTORY_DISPATCH_TRANSPORT=amqp' >> .env
pnpm dev
```

### The wire contract

`src/inventory/inventory.messages.ts` is the whole of it, and the file the
inventory service should copy (or import) when it grows a consumer:

- Exchange `inventory`, topic, durable. Routing keys `inventory.stock.release`
  (published here), `inventory.stock.fulfil` and `inventory.stock.return` (to
  be published by the order service).
- Queue `inventory.stock`, durable, bound to `inventory.stock.*`, dead-lettering
  to the fanout exchange `inventory.dlx` and from there to `inventory.stock.dead`.
  Declared by this publisher as well as the consumer, on purpose: a topic
  exchange with no bound queue drops messages *and confirms them*, so without
  this every release published before inventory's consumer first ran would be
  lost. Both sides must declare it identically or RabbitMQ closes the channel
  with `PRECONDITION_FAILED`; the other copy is
  `services/inventory/src/messaging/inventory-events.ts`.
- Every message is persistent JSON with a `messageId`, also set as the AMQP
  `messageId` property. Delivery is at-least-once and stock transitions are
  not idempotent, so **the consumer must dedupe on `messageId`**.
- `correlationId` carries the same request id the HTTP path sends as
  `x-request-id`; `actor` the same identity as `x-actor-id`.

The consumer lives in the inventory service (`src/modules/inventory/inventory.consumer.ts`
there) and runs when that service has `RABBITMQ_URL` set. It applies a release through
the same service method as the HTTP bulk endpoint, dedupes on `messageId` inside the same
database transaction as the stock change, acks on success or on a duplicate, dead-letters a
release inventory refuses or a message it cannot parse, and requeues after a pause when the
database is the problem.
