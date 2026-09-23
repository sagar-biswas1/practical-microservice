export { InventoryModule } from './inventory.module';
export { HttpInventoryAdapter } from './inventory.http.adapter';
export { AmqpInventoryDispatch } from './inventory.amqp.adapter';
export { INVENTORY_HTTP, InjectInventoryHttp } from './inventory.constants';
export { InsufficientStockException } from './insufficient-stock.exception';
export {
  INVENTORY_DISPATCH,
  INVENTORY_PORT,
  InjectInventory,
  InjectInventoryDispatch,
  type InventoryDispatch,
  type InventoryPort,
  type StockChangeOptions,
} from './inventory.port';
export {
  INVENTORY_DEAD_LETTER_EXCHANGE,
  INVENTORY_EXCHANGE,
  INVENTORY_STOCK_DEAD_QUEUE,
  INVENTORY_STOCK_QUEUE,
  INVENTORY_TOPOLOGY,
  InventoryRoutingKey,
  buildStockChangeMessage,
  routingKeyFor,
  type InventoryMessage,
  type ReleaseStockMessage,
  type StockChangePayload,
} from './inventory.messages';
export {
  MAX_BULK_LINES,
  type CallContext,
  type InventoryItem,
  type StockFailure,
  type StockLine,
} from './inventory.types';
