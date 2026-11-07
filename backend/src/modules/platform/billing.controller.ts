import { Body, Controller, Get, Header, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { formatMinor } from '@pos/shared';
import type { Response } from 'express';
import { ChangePlanSchema, MarkPaidSchema, PlanSchema } from '@pos/shared';
import { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { AppError } from '../../common/errors/app-error.js';
import { AllowWhenBillingSuspended, Public, Realm, RequiresPermission } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { BillingService } from './billing.service.js';
import { BILLING_GATEWAY, type BillingGateway } from './payments/billing-gateway.js';
import { SandboxGateway } from './payments/sandbox-gateway.js';

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

/** A tenant's own plan, usage and invoices. Reachable while suspended for non-payment, so the owner can pay. */
@AllowWhenBillingSuspended()
@Controller('billing')
export class TenantBillingController {
  constructor(private readonly billing: BillingService) {}

  @RequiresPermission('billing.view')
  @Get()
  get(@Req() req: RequestWithContext) {
    return this.billing.tenantBilling(req.tenant!.id);
  }

  @RequiresPermission('billing.pay')
  @Post('invoices/:id/checkout')
  @HttpCode(200)
  checkout(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.billing.checkout(req.tenant!.id, id, req.principal!.userId, `${req.protocol}://${req.get('host')}`);
  }
}

/**
 * Gateways post outcomes here. The signature is the authentication, so any host serves it and the
 * platform IP allowlist does not apply (gateways call from their own addresses).
 */
@Public()
@Realm('any')
@Controller('platform/billing/webhooks')
export class BillingWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post(':provider')
  @HttpCode(200)
  webhook(@Req() req: RequestWithContext, @Param('provider') provider: string) {
    return this.billing.webhook(provider, req.rawBody, req.headers);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Only paths on this host: never an open redirect. */
const safeReturn = (r: unknown) => (typeof r === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(r) && !r.startsWith('//') ? r : '/billing');

/**
 * The sandbox gateway's "hosted page", on the tenant's host. Only registered when the sandbox
 * gateway is the configured one (never in production).
 */
@Public()
@AllowWhenBillingSuspended()
@Controller('billing/sandbox/checkout')
export class SandboxCheckoutController {
  constructor(
    private readonly billing: BillingService,
    @Optional() @Inject(BILLING_GATEWAY) private readonly gateway: BillingGateway | null = null,
  ) {}

  private sandbox(): SandboxGateway {
    if (!(this.gateway instanceof SandboxGateway)) throw AppError.notFound();
    return this.gateway;
  }

  @Get(':session')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async page(@Param('session') session: string, @Query('return') ret?: string) {
    this.sandbox();
    const s = await this.billing.sandboxSession(session);
    const back = encodeURIComponent(safeReturn(ret));
    const form = (outcome: string, label: string) =>
      `<form method="post" action="/api/billing/sandbox/checkout/${esc(session)}/${outcome}?return=${back}"><button type="submit" name="go" value="1">${label}</button></form>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Sandbox checkout</title>
<style>body{font:16px system-ui;max-width:420px;margin:48px auto;padding:0 16px}.box{border:1px solid #ccc;border-radius:8px;padding:24px}
button{font:inherit;padding:10px 18px;margin-top:12px;width:100%;cursor:pointer}.note{color:#666;font-size:13px}</style></head>
<body><div class="box"><p class="note">Sandbox payment gateway: no money moves.</p>
<h1>Pay ${esc(formatMinor(s.amount, s.currency))} ${esc(s.currency)}</h1><p>Invoice ${esc(s.invoiceNumber)}</p>
${s.status === 'PENDING' ? form('pay', 'Pay now') + form('decline', 'Decline the card') : `<p>This checkout is ${esc(s.status.toLowerCase())}.</p>`}
</div></body></html>`;
  }

  @Post(':session/:outcome')
  async complete(@Param('session') session: string, @Param('outcome') outcome: string, @Query('return') ret: string | undefined, @Res() res: Response) {
    const gw = this.sandbox();
    if (outcome !== 'pay' && outcome !== 'decline') throw AppError.notFound();
    const s = await this.billing.sandboxSession(session);
    const { body, headers } = gw.webhook({
      sessionId: session, amount: s.amount, currency: s.currency,
      ...(outcome === 'pay' ? { status: 'SUCCEEDED' as const, providerRef: `sbx_pay_${Date.now().toString(36)}` } : { status: 'FAILED' as const, failureReason: 'Card declined' }),
    });
    // The same path a real gateway's webhook takes: signature check, then apply once.
    await this.billing.webhook(gw.key, body, headers);
    const back = safeReturn(ret);
    res.redirect(303, `${back}?payment=${outcome === 'pay' ? 'success' : 'failed'}`);
  }
}
