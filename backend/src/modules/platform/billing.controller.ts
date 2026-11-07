import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ChangePlanSchema, MarkPaidSchema, PlanSchema } from '@pos/shared';
import { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm, RequiresPermission } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { BillingService } from './billing.service.js';

const uuid = new ParseUUIDPipe();
const StatusQuery = z.object({ status: z.enum(['DUE', 'PAID', 'VOID']).optional() });

@Realm('platform')
@Controller('platform')
export class PlatformBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  plans() {
    return this.billing.plans();
  }

  @Post('plans')
  savePlan(@Req() req: RequestWithContext, @Body(new ZodPipe(PlanSchema)) body: z.infer<typeof PlanSchema>) {
    return this.billing.savePlan(platformAuditContext(req), body);
  }

  @Put('tenants/:id/plan')
  changePlan(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(ChangePlanSchema)) body: z.infer<typeof ChangePlanSchema>) {
    return this.billing.changePlan(platformAuditContext(req), id, body.planKey);
  }

  @Get('tenants/:id/billing')
  tenantBilling(@Param('id', uuid) id: string) {
    return this.billing.tenantBilling(id);
  }

  @Get('invoices')
  invoices(@Query(new ZodPipe(StatusQuery)) q: z.infer<typeof StatusQuery>) {
    return this.billing.invoices(q.status);
  }

  /** Runs the daily billing pass now: issue this month's invoices, suspend overdue tenants. */
  @Post('billing/run')
  @HttpCode(200)
  async run() {
    return { ...(await this.billing.issueMonthly()), ...(await this.billing.enforceOverdue()) };
  }

  @Post('invoices/:id/pay')
  @HttpCode(200)
  pay(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(MarkPaidSchema)) body: z.infer<typeof MarkPaidSchema>) {
    return this.billing.markPaid(platformAuditContext(req), id, body.reference);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  voidInvoice(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.billing.voidInvoice(platformAuditContext(req), id);
  }
}

/** A tenant's own plan, usage and invoices. */
@Controller('billing')
export class TenantBillingController {
  constructor(private readonly billing: BillingService) {}

  @RequiresPermission('billing.view')
  @Get()
  get(@Req() req: RequestWithContext) {
    return this.billing.tenantBilling(req.tenant!.id);
  }
}
