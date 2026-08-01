-- AlterEnum
-- Postgres appends the label to the enum; existing rows are untouched and
-- no lock beyond the type itself is taken.
ALTER TYPE "StockMovementType" ADD VALUE 'RETURN';
