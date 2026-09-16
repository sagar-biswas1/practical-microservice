import { IsUUID } from 'class-validator';

export class CheckoutCartDto {
  /**
   * The order the hold moves to.
   *
   * Minted by the order service *before* it calls this, so the reference on
   * inventory's ledger rows matches an order that already exists. An id
   * generated here would leave a hold pointing at nothing if the order write
   * then failed.
   */
  @IsUUID()
  orderId!: string;
}
