-- CreateTable
CREATE TABLE "inventory_audit_logs" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "field" VARCHAR(64) NOT NULL,
    "old_value" VARCHAR(200),
    "new_value" VARCHAR(200),
    "actor" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_audit_logs_item_id_created_at_idx" ON "inventory_audit_logs"("item_id", "created_at");

-- AddForeignKey
ALTER TABLE "inventory_audit_logs" ADD CONSTRAINT "inventory_audit_logs_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

