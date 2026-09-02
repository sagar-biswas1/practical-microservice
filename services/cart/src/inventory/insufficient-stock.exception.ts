import { ConflictException } from '@nestjs/common';

import type { StockFailure } from './inventory.types';

/**
 * A bulk reservation or release that inventory refused, carrying the reason
 * for every rejected line rather than only the first.
 *
 * Modelled as a Nest exception so it maps to a 409 on its own if it reaches
 * the request boundary unhandled, while still being catchable by anything
 * that wants to react to the individual lines — showing a shopper which
 * items to reduce, for instance.
 */
export class InsufficientStockException extends ConflictException {
  constructor(
    message: string,
    readonly failures: StockFailure[],
  ) {
    super({ message, failures });
  }

  /** The products that could not be satisfied, for a quick membership test. */
  get productIds(): string[] {
    return this.failures.map((failure) => failure.productId);
  }
}
