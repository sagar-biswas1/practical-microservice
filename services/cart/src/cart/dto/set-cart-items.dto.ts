import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';

import { MAX_BULK_LINES } from '../../inventory';

export class CartItemDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  /**
   * The quantity the cart should end up holding, not an amount to add.
   *
   * Zero removes the line and hands its units back — the natural bottom of a
   * "set it to this" endpoint, and the only way a shopper can drop an item
   * without abandoning the whole cart.
   */
  @IsInt()
  @Min(0)
  quantity!: number;
}

export class SetCartItemsDto {
  /**
   * Capped at inventory's own bulk limit. A cart that grew past it could
   * still be built line by line, so the service checks the resulting cart
   * size as well — this only keeps an oversized body from getting that far.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_LINES)
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];
}
