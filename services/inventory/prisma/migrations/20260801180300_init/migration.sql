-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('INBOUND', 'OUTBOUND', 'RESERVATION', 'RELEASE', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "product_id" UUID NOT NULL,
    "warehouse" VARCHAR(64) NOT NULL DEFAULT 'default',
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "reorder_level" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movement_histories" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity_changed" INTEGER NOT NULL,
    "last_quantity" INTEGER NOT NULL,
    "reason" VARCHAR(500),
    "reference" VARCHAR(120),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_histories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_sku_key" ON "inventory_items"("sku");

-- CreateIndex
CREATE INDEX "inventory_items_product_id_idx" ON "inventory_items"("product_id");

-- CreateIndex
CREATE INDEX "inventory_items_warehouse_idx" ON "inventory_items"("warehouse");

-- CreateIndex
CREATE INDEX "stock_movement_histories_item_id_created_at_idx" ON "stock_movement_histories"("item_id", "created_at");

-- AddForeignKey
ALTER TABLE "stock_movement_histories" ADD CONSTRAINT "stock_movement_histories_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
