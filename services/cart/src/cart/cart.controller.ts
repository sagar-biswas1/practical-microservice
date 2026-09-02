import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import type { CallContext } from '../inventory';
import { CART_SESSION_HEADER } from './cart.constants';
import { CartService } from './cart.service';
import { CartSessionId } from './decorators/cart-session.decorator';
import { RequestContext } from './decorators/request-context.decorator';
import { SetCartItemsDto } from './dto/set-cart-items.dto';
import type { CartLine } from './cart.types';

/**
 * The cart's HTTP surface.
 *
 * Transport only: reading headers, choosing status codes, and turning a
 * missing cart into a 404. Deciding which session a request belongs to is
 * `CartService.resolveSession` — that is a rule about carts, not about HTTP,
 * and it used to live here.
 */
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  /**
   * Sets the quantity of each named line.
   *
   * Absolute, not additive: sending `p1: 10` leaves the cart holding 10 of
   * `p1` however many it held before, and sending the same body twice changes
   * nothing the second time. A quantity of zero removes the line.
   *
   * 200 rather than 201: the same request creates a cart or updates one, and
   * which of the two happened is not something the caller has to care about.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async setItems(
    @Body() dto: SetCartItemsDto,
    @CartSessionId() claimed: string | null,
    @RequestContext() context: CallContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CartLine[]> {
    const { cartSessionId } = await this.cartService.resolveSession(claimed);
    // Echoed on every response, not only when the session is new: a client
    // that loses track of its id can always recover it from the last reply.
    res.setHeader(CART_SESSION_HEADER, cartSessionId);

    return this.cartService.setLines(dto.items, cartSessionId, context);
  }

  /** The cart behind the claimed session. */
  @Get()
  async getCart(
    @CartSessionId() claimed: string | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CartLine[]> {
    const cartSessionId = await this.requireSession(claimed);
    res.setHeader(CART_SESSION_HEADER, cartSessionId);

    return this.cartService.lines(cartSessionId);
  }

  /**
   * Abandons the cart, handing every held unit straight back to inventory
   * rather than waiting for it to expire.
   *
   * Idempotent, and deliberately quiet about a cart that has already gone: a
   * client cancelling twice, or cancelling something that expired a moment
   * earlier, has got what it asked for either way.
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async abandon(@CartSessionId() claimed: string | null): Promise<void> {
    if (!claimed) return;
    await this.cartService.releaseSession(claimed, 'abandoned');
  }

  /**
   * A cart that has expired is gone, not malformed — 404 rather than the 400
   * this used to answer, so a client can tell "your id is stale, start again"
   * from "your request was wrong".
   */
  private async requireSession(claimed: string | null): Promise<string> {
    if (!claimed) {
      throw new NotFoundException(
        `No cart session; send one in the '${CART_SESSION_HEADER}' header`,
      );
    }

    if (!(await this.cartService.touchSession(claimed))) {
      throw new NotFoundException('This cart has expired');
    }

    return claimed;
  }
}
