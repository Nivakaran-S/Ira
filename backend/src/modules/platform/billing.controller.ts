import { Body, Controller, Get, Header, HttpCode, Inject, Logger, Optional, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
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
import { BILLING_GATEWAY, type BillingGateway, type GatewayEvent } from './payments/billing-gateway.js';
import { evaluateCard, SANDBOX_OTP, TEST_CARDS } from './payments/sandbox-cards.js';
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
 * The sandbox gateway's hosted checkout, on the tenant's host. Only registered when the sandbox
 * gateway is the configured one (never in production). It behaves like a card provider's page:
 * a card form with validation, test cards for each outcome, a 3-D Secure code step, three tries
 * before the checkout is abandoned, a Cancel link, and a signed webhook that (with
 * SANDBOX_WEBHOOK_DELAY_MS) arrives after the browser has already come back, is sent twice, and is
 * retried when we answer with an error.
 */
@Public()
@AllowWhenBillingSuspended()
@Controller('billing/sandbox/checkout')
export class SandboxCheckoutController {
  private readonly log = new Logger('SandboxGateway');

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
    const gw = this.sandbox();
    const s = await this.billing.sandboxSession(session);
    if (s.status !== 'PENDING') return this.shell(s, `<p>This checkout is ${esc(s.status.toLowerCase())}.</p>`);
    const c = gw.challenge(session);
    return c ? this.challengePage(s, session, ret, c) : this.cardPage(s, session, ret);
  }

  @Post(':session/card')
  async card(@Param('session') session: string, @Body() body: Record<string, unknown>, @Query('return') ret: string | undefined, @Res() res: Response) {
    const gw = this.sandbox();
    const s = await this.billing.sandboxSession(session);
    if (s.status !== 'PENDING') return res.redirect(303, `${safeReturn(ret)}?payment=${s.status === 'SUCCEEDED' ? 'success' : 'failed'}`);
    const field = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).slice(0, 40) : '');
    const input = { number: field('number'), expiry: field('expiry'), cvc: field('cvc'), name: field('name') };
    const out = evaluateCard(input);
    const show = (html: string) => res.status(200).type('html').set('Cache-Control', 'no-store').send(html);
    if (out.kind === 'invalid') return show(this.cardPage(s, session, ret, { error: out.message, name: input.name }));
    if (out.kind === 'challenge') {
      gw.startChallenge(session, out.brand, out.last4);
      return res.redirect(303, `/api/billing/sandbox/checkout/${esc(session)}?return=${encodeURIComponent(safeReturn(ret))}`);
    }
    if (out.kind === 'declined') {
      if (gw.strike(session) < 3) return show(this.cardPage(s, session, ret, { error: out.reason, name: input.name }));
      return this.settle(gw, session, s, { status: 'FAILED', failureReason: out.reason }, ret, res);
    }
    return this.settle(gw, session, s, { status: 'SUCCEEDED', providerRef: `sbx_pay_${Date.now().toString(36)}` }, ret, res);
  }

  @Post(':session/3ds')
  async challenge(@Param('session') session: string, @Body() body: Record<string, unknown>, @Query('return') ret: string | undefined, @Res() res: Response) {
    const gw = this.sandbox();
    const s = await this.billing.sandboxSession(session);
    const c = gw.challenge(session);
    if (s.status !== 'PENDING' || !c) return res.redirect(303, `/api/billing/sandbox/checkout/${esc(session)}?return=${encodeURIComponent(safeReturn(ret))}`);
    if (typeof body.code === 'string' && body.code.trim() === SANDBOX_OTP) {
      gw.endChallenge(session);
      return this.settle(gw, session, s, { status: 'SUCCEEDED', providerRef: `sbx_pay_${Date.now().toString(36)}` }, ret, res);
    }
    if (gw.failChallenge(session) === 'locked') {
      return this.settle(gw, session, s, { status: 'FAILED', failureReason: 'Card authentication failed' }, ret, res);
    }
    res.status(200).type('html').set('Cache-Control', 'no-store').send(this.challengePage(s, session, ret, c, 'That code is not right. Try again.'));
  }

  @Post(':session/cancel')
  async cancel(@Param('session') session: string, @Query('return') ret: string | undefined, @Res() res: Response) {
    const gw = this.sandbox();
    const s = await this.billing.sandboxSession(session);
    if (s.status !== 'PENDING') return res.redirect(303, `${safeReturn(ret)}?payment=${s.status === 'SUCCEEDED' ? 'success' : 'cancelled'}`);
    gw.endChallenge(session);
    await this.deliver(gw, { sessionId: session, amount: s.amount, currency: s.currency, status: 'FAILED', failureReason: 'Cancelled by the payer' });
    res.redirect(303, `${safeReturn(ret)}?payment=cancelled`);
  }

  /** The browser goes back at once; the webhook follows straight away or, with a delay, a moment later. */
  private async settle(
    gw: SandboxGateway, session: string, s: { amount: number; currency: string },
    result: { status: 'SUCCEEDED'; providerRef: string } | { status: 'FAILED'; failureReason: string },
    ret: string | undefined, res: Response,
  ) {
    const event: GatewayEvent = { sessionId: session, amount: s.amount, currency: s.currency, ...result };
    const delay = gw.options.webhookDelayMs;
    if (delay > 0) {
      setTimeout(() => void this.deliver(gw, event, true), delay).unref();
      return res.redirect(303, `${safeReturn(ret)}?payment=submitted`);
    }
    await this.deliver(gw, event);
    res.redirect(303, `${safeReturn(ret)}?payment=${result.status === 'SUCCEEDED' ? 'success' : 'failed'}`);
  }

  /** What a provider does: sign it, post it, retry with growing gaps if we error, and (like most) sometimes send it twice. */
  private async deliver(gw: SandboxGateway, event: GatewayEvent, atLeastTwice = false) {
    const once = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const { body, headers } = gw.webhook(event);
        try {
          await this.billing.webhook(gw.key, body, headers);
          return;
        } catch (e) {
          this.log.warn(`webhook for ${event.sessionId} failed (attempt ${attempt + 1}): ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, 200 * 4 ** attempt));
        }
      }
    };
    await once();
    if (atLeastTwice) await once();
  }

  private cardPage(s: PageSession, session: string, ret: string | undefined, o: { error?: string; name?: string } = {}) {
    const rows = TEST_CARDS.map((c) => `<tr><td><code>${esc(c.number)}</code></td><td>${esc(c.what)}</td></tr>`).join('');
    return this.shell(s, `
<form method="post" action="${this.action(session, 'card', ret)}" autocomplete="off" data-testid="sandbox-card-form">
  ${o.error ? `<div class="err" role="alert" data-testid="sandbox-error">${esc(o.error)}</div>` : ''}
  <label>Card number<input name="number" inputmode="numeric" placeholder="1234 1234 1234 1234" autocomplete="off" required></label>
  <div class="two"><label>Expiry<input name="expiry" placeholder="MM / YY" autocomplete="off" required></label>
  <label>Security code<input name="cvc" inputmode="numeric" placeholder="CVC" autocomplete="off" required></label></div>
  <label>Name on card<input name="name" value="${esc(o.name ?? '')}" autocomplete="off" required></label>
  <button type="submit" class="pay">Pay ${esc(formatMinor(s.amount, s.currency))} ${esc(s.currency)}</button>
</form>
<form method="post" action="${this.action(session, 'cancel', ret)}"><button type="submit" class="link">Cancel and go back</button></form>
<details><summary>Test cards</summary><p class="note">Any future expiry, any 3-digit security code (4 for Amex), any name.</p><table>${rows}</table></details>`);
  }

  private challengePage(s: PageSession, session: string, ret: string | undefined, c: { brand: string; last4: string }, error?: string) {
    return this.shell(s, `
<p><strong>Confirm it is you</strong></p>
<p class="note">Your bank sent a code to confirm this payment on your ${esc(c.brand)} ending ${esc(c.last4)}. In the sandbox the code is <code>${SANDBOX_OTP}</code>.</p>
<form method="post" action="${this.action(session, '3ds', ret)}" data-testid="sandbox-3ds-form">
  ${error ? `<div class="err" role="alert" data-testid="sandbox-error">${esc(error)}</div>` : ''}
  <label>One-time code<input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required></label>
  <button type="submit" class="pay">Confirm</button>
</form>
<form method="post" action="${this.action(session, 'cancel', ret)}"><button type="submit" class="link">Cancel and go back</button></form>`);
  }

  private action(session: string, step: string, ret: string | undefined) {
    return `/api/billing/sandbox/checkout/${esc(session)}/${step}?return=${encodeURIComponent(safeReturn(ret))}`;
  }

  private shell(s: PageSession, inner: string) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox checkout</title>
<style>body{font:16px system-ui;max-width:440px;margin:40px auto;padding:0 16px;color:#1a1a1a}.box{border:1px solid #d0d0d0;border-radius:10px;padding:24px}
label{display:block;font-size:14px;margin-top:12px}input{display:block;width:100%;box-sizing:border-box;font:inherit;padding:10px;margin-top:4px;border:1px solid #bbb;border-radius:6px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}button{font:inherit;cursor:pointer}.pay{width:100%;margin-top:18px;padding:12px;border:0;border-radius:6px;background:#1a1a1a;color:#fff}
.link{background:none;border:0;color:#555;text-decoration:underline;margin-top:14px;padding:0}.note{color:#666;font-size:13px}.err{background:#fdecea;color:#a12622;padding:10px;border-radius:6px;font-size:14px}
table{font-size:13px;margin-top:8px}td{padding:2px 8px 2px 0}details{margin-top:18px}</style></head>
<body><div class="box"><p class="note">Sandbox payment gateway: no money moves.</p>
<h1>Pay ${esc(formatMinor(s.amount, s.currency))} ${esc(s.currency)}</h1><p>Invoice ${esc(s.invoiceNumber)}</p>
${inner}</div></body></html>`;
  }
}

type PageSession = { amount: number; currency: string; invoiceNumber: string };
