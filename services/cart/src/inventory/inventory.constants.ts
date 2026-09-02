import { Inject } from '@nestjs/common';

/**
 * The configured axios instance pointed at the inventory service.
 *
 * A token rather than the `AxiosInstance` type itself, because that type is a
 * TypeScript interface: it does not survive to runtime, so `emitDecoratorMetadata`
 * records the parameter as `Function` and Nest has nothing to resolve. Token
 * injection sidesteps the erasure entirely, and makes the HTTP client a
 * provider that can be swapped in tests like any other.
 */
export const INVENTORY_HTTP = 'INVENTORY_HTTP';

/** Injects the inventory-bound HTTP client. */
export const InjectInventoryHttp = () => Inject(INVENTORY_HTTP);
