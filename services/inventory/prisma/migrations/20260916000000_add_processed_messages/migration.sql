-- Idempotency ledger for the RabbitMQ stock-event consumer. One row per
-- consumed message, written in the same transaction as the stock change, so a
-- redelivered message fails on the primary key before it can touch stock.

-- CreateTable
CREATE TABLE "processed_messages" (
    "message_id" VARCHAR(120) NOT NULL,
    "type" VARCHAR(120) NOT NULL,
    "reference" VARCHAR(120),
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE INDEX "processed_messages_processed_at_idx" ON "processed_messages"("processed_at");

