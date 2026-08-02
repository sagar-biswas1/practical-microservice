-- One inventory record per product. Fails if duplicates already exist:
--   SELECT product_id FROM inventory_items GROUP BY product_id HAVING count(*) > 1;
-- The plain index is dropped because the unique constraint supplies one.

-- DropIndex
DROP INDEX "inventory_items_product_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_product_id_key" ON "inventory_items"("product_id");

