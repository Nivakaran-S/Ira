import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import {
  AddOrderLinesSchema, DiningTableSchema, KitchenBumpSchema, ModifierGroupSchema, MoveOrderSchema, OpenOrderSchema, PayOrderSchema, SetProductModifiersSchema,
} from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresDevice, RequiresModule, RequiresPermission } from '../access/decorators.js';
import { StepUpGate } from '../access/step-up-gate.js';
import { auditContext } from '../audit/audit-context.js';
import { ModifiersService } from './modifiers.service.js';
import { OrdersService } from './orders.service.js';

const uuid = new ParseUUIDPipe();

@RequiresModule('modifiers')
@RequiresPermission('catalog.manage')
@Controller()
export class ModifiersController {
  constructor(private readonly modifiers: ModifiersService) {}

  @Get('modifier-groups')
  list(@Req() req: RequestWithContext) {
    return this.modifiers.list(req.tenant!);
  }

  @Post('modifier-groups')
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(ModifierGroupSchema)) body: z.infer<typeof ModifierGroupSchema>) {
    return this.modifiers.save(req.tenant!, auditContext(req), body);
  }

  @Put('modifier-groups/:id')
  update(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(ModifierGroupSchema)) body: z.infer<typeof ModifierGroupSchema>) {
    return this.modifiers.save(req.tenant!, auditContext(req), body, id);
  }

  @Put('products/:id/modifier-groups')
  setForProduct(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(SetProductModifiersSchema)) body: z.infer<typeof SetProductModifiersSchema>) {
    return this.modifiers.setProductGroups(req.tenant!, auditContext(req), id, body.groupIds);
  }
}

@RequiresModule('tables')
@Controller('tables')
export class TablesController {
  constructor(private readonly orders: OrdersService) {}

  @RequiresPermission('table.manage')
  @Get()
  list(@Req() req: RequestWithContext, @Query('storeId') storeId?: string) {
    return this.orders.listTables(req.tenant!, storeId && /^[0-9a-f-]{36}$/i.test(storeId) ? storeId : undefined);
  }

  @RequiresPermission('table.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(DiningTableSchema)) body: z.infer<typeof DiningTableSchema>) {
    return this.orders.createTable(req.tenant!, auditContext(req), body);
  }
}

/** Waiters and tills: tables, open orders (tabs), sending to the kitchen, paying. */
@RequiresModule('tables')
@RequiresDevice()
@RequiresPermission('sale.create')
@Controller('pos')
export class PosOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly gate: StepUpGate,
  ) {}

  /** Voiding what the kitchen already has always needs a manager approval; null when none came with the request. */
  private voidApproval(req: RequestWithContext) {
    return req.header('x-step-up-token') ? this.gate.require(req, 'sale.void').catch(() => null) : Promise.resolve(null);
  }

  @Get('floor')
  floor(@Req() req: RequestWithContext) {
    return this.orders.floor(req.tenant!, req.device!.registerId);
  }

  @Post('orders')
  open(@Req() req: RequestWithContext, @Body(new ZodPipe(OpenOrderSchema)) body: z.infer<typeof OpenOrderSchema>) {
    return this.orders.open(req, body);
  }

  @Get('orders/:id')
  get(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.orders.get(req, id);
  }

  @Post('orders/:id/lines')
  @HttpCode(200)
  add(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(AddOrderLinesSchema)) body: z.infer<typeof AddOrderLinesSchema>) {
    return this.orders.addLines(req, id, body);
  }

  @Delete('orders/:id/lines/:lineId')
  async remove(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Param('lineId', uuid) lineId: string) {
    return this.orders.removeLine(req, id, lineId, await this.voidApproval(req));
  }

  @Post('orders/:id/send')
  @HttpCode(200)
  send(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.orders.send(req, id);
  }

  @Post('orders/:id/move')
  @HttpCode(200)
  move(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(MoveOrderSchema)) body: z.infer<typeof MoveOrderSchema>) {
    return this.orders.move(req, id, body.tableId);
  }

  @Post('orders/:id/pay')
  @HttpCode(200)
  pay(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(PayOrderSchema)) body: z.infer<typeof PayOrderSchema>) {
    return this.orders.pay(req, id, body);
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  async cancel(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.orders.cancel(req, id, await this.voidApproval(req));
  }
}

/** The kitchen display: any device in the store, signed in by someone with kitchen.view. */
@RequiresModule('kitchen-display')
@RequiresDevice()
@RequiresPermission('kitchen.view')
@Controller('pos/kitchen')
export class KitchenController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  tickets(@Req() req: RequestWithContext) {
    return this.orders.kitchen(req.tenant!, req.device!.registerId);
  }

  @Post('lines/:id')
  @HttpCode(200)
  bump(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(KitchenBumpSchema)) body: z.infer<typeof KitchenBumpSchema>) {
    return this.orders.bump(req.tenant!, req.device!.registerId, id, body.status);
  }
}
