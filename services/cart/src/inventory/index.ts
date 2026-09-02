export { InventoryClient } from './inventory.client';
export { InventoryModule } from './inventory.module';
export { INVENTORY_HTTP, InjectInventoryHttp } from './inventory.constants';
export { InsufficientStockException } from './insufficient-stock.exception';
export {
  MAX_BULK_LINES,
  type CallContext,
  type InventoryItem,
  type StockFailure,
  type StockLine,
} from './inventory.types';
