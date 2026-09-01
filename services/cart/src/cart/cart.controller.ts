import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CartService } from './cart.service';
import { CreateCartDto } from './dto/create-cart.dto';
import { UpdateCartDto } from './dto/update-cart.dto';
import { randomUUID } from 'node:crypto';

@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Post()
  async create(
    @Body() createCartDto: CreateCartDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    let cartSessionId = (req.headers['cart-session-id'] as string) || null;

    if (cartSessionId) {
      const exist = await this.cartService.checkCartSession(cartSessionId);
      if (!exist) cartSessionId = null;
    }

    if (!cartSessionId) {
      cartSessionId = randomUUID();
      await this.cartService.createCartSession(cartSessionId);
      res.setHeader('cart-session-id', cartSessionId); // sent to the client
    }

    return this.cartService.create(createCartDto, cartSessionId);
  }

  @Get()
  async findAll(@Req() req: Request) {
    const cartSessionId = (req.headers['cart-session-id'] as string) || null;
    if (!cartSessionId) {
      throw new BadRequestException('Cart session ID is required');
    }
    if (cartSessionId) {
      const exist = await this.cartService.checkCartSession(cartSessionId);
      if (!exist) throw new BadRequestException('Cart session ID is invalid');
    }
    return this.cartService.getCart(cartSessionId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.cartService.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateCartDto: UpdateCartDto) {
    return this.cartService.update(+id, updateCartDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.cartService.remove(+id);
  }
}
