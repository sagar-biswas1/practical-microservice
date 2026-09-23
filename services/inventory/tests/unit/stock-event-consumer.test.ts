import type { ConsumeMessage } from "amqplib";
import { beforeEach, describe, expect, it } from "vitest";
import { logger } from "../../src/lib/logger.js";
import { InventoryRoutingKey } from "../../src/messaging/inventory-events.js";
import { StockEventConsumer } from "../../src/modules/inventory/inventory.consumer.js";
import { InventoryService } from "../../src/modules/inventory/inventory.service.js";
import { InMemoryInventoryRepository } from "../helpers/in-memory-inventory-repository.js";

const PRODUCT_ID = "1c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_PRODUCT_ID = "b4f0e9d2-3a71-4c58-9f1e-2d6c8a5b7e34";

/** A delivery as amqplib hands it to a consumer, from a JSON-able body. */
function delivery(body: unknown, overrides: Partial<ConsumeMessage["fields"]> = {}): ConsumeMessage {
  const content = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    content,
    fields: {
      consumerTag: "ctag-1",
      deliveryTag: 1,
      redelivered: false,
      exchange: "inventory",
      routingKey: InventoryRoutingKey.release,
      ...overrides,
    },
    properties: {
      messageId: typeof body === "object" && body !== null ? (body as { messageId?: string }).messageId : undefined,
      contentType: "application/json",
    } as ConsumeMessage["properties"],
  } as ConsumeMessage;
}

/** What the cart publishes for one release, exactly as it builds it. */
function releaseEvent(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "8b4c5a2e-0001-4000-8000-000000000001",
    type: InventoryRoutingKey.release,
    occurredAt: "2026-09-16T10:00:00.000Z",
    correlationId: "req-1",
    actor: "cart-service",
    payload: {
      items: [{ productId: PRODUCT_ID, quantity: 2 }],
      reference: "cart_1",
      reason: "Cart expired",
    },
    ...overrides,
  };
}

describe("StockEventConsumer", () => {
  let repository: InMemoryInventoryRepository;
  let service: InventoryService;
  let consumer: StockEventConsumer;

  beforeEach(() => {
    repository = new InMemoryInventoryRepository([
      InMemoryInventoryRepository.buildItem({ productId: PRODUCT_ID, quantity: 10, reserved: 5 }),
    ]);
    service = new InventoryService(repository);
    consumer = new StockEventConsumer(service, logger);
  });

  it("applies a release and acks, recording the reference on the ledger", async () => {
    const outcome = await consumer.handle(delivery(releaseEvent()));

    expect(outcome).toBe("ack");
    const item = await repository.findByProductId(PRODUCT_ID);
    expect(item?.reserved).toBe(3);

    const { items: movements } = await repository.listMovements(item!.id, {
      page: 1,
      limit: 10,
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "RELEASE",
      quantityChanged: 2,
      reference: "cart_1",
      reason: "Cart expired",
    });
  });

  it("acks a redelivery of a message it has already applied, without applying it twice", async () => {
    const event = releaseEvent();

    expect(await consumer.handle(delivery(event))).toBe("ack");
    expect(await consumer.handle(delivery(event, { redelivered: true }))).toBe("ack");

    const item = await repository.findByProductId(PRODUCT_ID);
    // Applied exactly once: 5 held, 2 released, not 4.
    expect(item?.reserved).toBe(3);
    expect(repository.movementCount).toBe(1);
  });

  it("treats a different messageId for the same cart as a separate release", async () => {
    await consumer.handle(delivery(releaseEvent({ messageId: "m-1" })));
    await consumer.handle(delivery(releaseEvent({ messageId: "m-2" })));

    const item = await repository.findByProductId(PRODUCT_ID);
    expect(item?.reserved).toBe(1);
  });

  it("rejects a release inventory refuses, so it is dead-lettered rather than retried or dropped", async () => {
    // Only 5 are held; releasing 8 is the signature of a release that already
    // landed some other way. Retrying cannot change the answer.
    const outcome = await consumer.handle(
      delivery(
        releaseEvent({
          payload: { items: [{ productId: PRODUCT_ID, quantity: 8 }], reference: "cart_1" },
        }),
      ),
    );

    expect(outcome).toBe("reject");
    const item = await repository.findByProductId(PRODUCT_ID);
    expect(item?.reserved).toBe(5);
    // A refused batch leaves no idempotency record behind.
    expect(repository.processedMessageCount).toBe(0);
  });

  it("rejects a release for a product with no stock record", async () => {
    const outcome = await consumer.handle(
      delivery(
        releaseEvent({
          payload: { items: [{ productId: OTHER_PRODUCT_ID, quantity: 1 }], reference: "cart_9" },
        }),
      ),
    );

    expect(outcome).toBe("reject");
  });

  it("rejects a body that is not JSON", async () => {
    expect(await consumer.handle(delivery("{not json"))).toBe("reject");
  });

  it("rejects an envelope that fails validation", async () => {
    expect(await consumer.handle(delivery(releaseEvent({ messageId: "" })))).toBe("reject");
    expect(await consumer.handle(delivery(releaseEvent({ occurredAt: "yesterday" })))).toBe(
      "reject",
    );
    expect(
      await consumer.handle(
        delivery(releaseEvent({ payload: { items: [], reference: "cart_1" } })),
      ),
    ).toBe("reject");
    expect(await consumer.handle(delivery(releaseEvent({ type: "inventory.stock.explode" })))).toBe(
      "reject",
    );
  });

  it("rejects an unknown payload field, as the HTTP endpoint would", async () => {
    const outcome = await consumer.handle(
      delivery(
        releaseEvent({
          payload: {
            items: [{ productId: PRODUCT_ID, quantity: 1 }],
            reference: "cart_1",
            warehouse: "north",
          },
        }),
      ),
    );

    expect(outcome).toBe("reject");
  });

  it("tolerates unknown envelope fields, so the publisher can add some first", async () => {
    const outcome = await consumer.handle(
      delivery(releaseEvent({ schemaVersion: 2, publishedBy: "cart-service@1.4" })),
    );

    expect(outcome).toBe("ack");
  });

  it("rejects fulfil and return events until the service can apply them", async () => {
    expect(
      await consumer.handle(delivery(releaseEvent({ type: InventoryRoutingKey.fulfil }))),
    ).toBe("reject");
    expect(
      await consumer.handle(delivery(releaseEvent({ type: InventoryRoutingKey.return }))),
    ).toBe("reject");
    // Nothing moved.
    const item = await repository.findByProductId(PRODUCT_ID);
    expect(item?.reserved).toBe(5);
  });

  it("requeues when the service fails on something that is not a refusal", async () => {
    const broken = {
      releaseMany: () => Promise.reject(new Error("connection to database lost")),
    } as unknown as InventoryService;

    const outcome = await new StockEventConsumer(broken, logger).handle(delivery(releaseEvent()));

    expect(outcome).toBe("requeue");
  });
});
