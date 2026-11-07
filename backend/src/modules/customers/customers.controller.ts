import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { CustomerSchema, LedgerAdjustSchema, UpdateCustomerSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresDevice, RequiresModule, RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { CustomersService } from './customers.service.js';

const uuid = new ParseUUIDPipe();

@RequiresModule('customers')
@RequiresPermission('customer.manage')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  async list(@Req() req: RequestWithContext, @Query('q') q?: string) {
    if (q?.trim()) return (await this.customers.search(req.tenant!, q.slice(0, 80), 50)).map((r) => ({ ...this.customers.view(r.row), ...r.balances }));
    return this.customers.list(req.tenant!);
  }

  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CustomerSchema)) body: z.infer<typeof CustomerSchema>) {
    return this.customers.create(req.tenant!, auditContext(req), body);
  }

  @Get(':id')
  get(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.customers.get(req.tenant!, id);
  }

  @Patch(':id')
  update(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(UpdateCustomerSchema)) body: z.infer<typeof UpdateCustomerSchema>) {
    return this.customers.update(req.tenant!, auditContext(req), id, body);
  }

  @RequiresModule('loyalty')
  @Post(':id/loyalty/adjust')
  adjustPoints(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(LedgerAdjustSchema)) body: z.infer<typeof LedgerAdjustSchema>) {
    return this.customers.adjust(req.tenant!, auditContext(req), id, 'loyalty', body.delta, body.reason);
  }

  @Post(':id/credit/adjust')
  adjustCredit(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(LedgerAdjustSchema)) body: z.infer<typeof LedgerAdjustSchema>) {
    return this.customers.adjust(req.tenant!, auditContext(req), id, 'credit', body.delta, body.reason);
  }
}

/** Till lookups: names, last four digits and balances only. */
@RequiresModule('customers')
@RequiresDevice()
@RequiresPermission('sale.create')
@Controller('pos/customers')
export class PosCustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  async search(@Req() req: RequestWithContext, @Query('q') q?: string) {
    const rows = await this.customers.search(req.tenant!, (q ?? '').slice(0, 80), 20);
    return rows.map((r) => this.customers.tillView(r.row, r.balances));
  }

  @Post()
  async create(@Req() req: RequestWithContext, @Body(new ZodPipe(CustomerSchema)) body: z.infer<typeof CustomerSchema>) {
    const c = await this.customers.create(req.tenant!, auditContext(req), body);
    return { id: c.id, name: c.name, phoneLast4: c.phone ? c.phone.slice(-4) : null, points: 0, credit: 0 };
  }
}
