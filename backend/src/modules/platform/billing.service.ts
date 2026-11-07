import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { PlanSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { TenantResolverService } from '../access/tenant-resolver.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { BILLING_GATEWAY, type BillingGateway, type GatewayEvent } from './payments/billing-gateway.js';

type Ctx = ReturnType<typeof platformAuditContext>;
const SYSTEM: Ctx = { actorId: null, ip: null, userAgent: null, correlationId: 'billing-job' };
const GATEWAY: Ctx = { actorId: null, ip: null, userAgent: null, correlationId: 'billing-gateway' };

const day = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * Plans and invoices. Each paying tenant gets one invoice per calendar month, due a week after the
 * month starts. Owners pay online through the configured gateway (hosted checkout, confirmed by a
 * signed webhook), or a super admin records a payment made another way (bank transfer and the
 * like). A tenant still unpaid `graceDays` after the due date is suspended, and reactivated
 * automatically once nothing is overdue.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly resolver: TenantResolverService,
    private readonly audit: AuditService,
    @Optional() @Inject(BILLING_GATEWAY) private readonly gateway: BillingGateway | null = null,
  ) {}

  // ── plans ──
  plans() {
    return this.prisma.plan.findMany({ orderBy: { priceMonthly: 'asc' }, include: { _count: { select: { tenants: true } } } });
  }

  async savePlan(ctx: Ctx, input: z.infer<typeof PlanSchema>) {
    const before = await this.prisma.plan.findUnique({ where: { key: input.key } });
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.plan.upsert({ where: { key: input.key }, create: input, update: input });
      await this.audit.recordPlatform(tx, { ...ctx, action: before ? 'plan.updated' : 'plan.created', entityType: 'Plan', entityId: plan.id, before, after: input });
      return plan;
    });
  }

  async changePlan(ctx: Ctx, tenantId: string, planKey: string) {
    const [tenant, plan] = await Promise.all([this.prisma.tenant.findUnique({ where: { id: tenantId }, include: { plan: true } }), this.prisma.plan.findUnique({ where: { key: planKey } })]);
    if (!tenant || !plan) throw AppError.notFound('Tenant or plan not found');
    // Moving down must not leave the tenant above the new limits.
    const usage = await this.usage(tenantId);
    const over = (['stores', 'devices', 'users', 'products'] as const).filter((k) => usage[k] > plan[`max${k[0].toUpperCase()}${k.slice(1)}` as 'maxStores']);
    if (over.length) throw new AppError('PLAN_LIMIT_REACHED', 409, 'The tenant uses more than this plan allows', { over });
    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { planId: plan.id } });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.plan_changed', entityType: 'Tenant', entityId: tenantId, before: { plan: tenant.plan.key }, after: { plan: plan.key } });
    });
    await this.resolver.invalidateTenant(tenantId);
    return { planKey: plan.key };
  }

  /** What the tenant uses against its plan's limits. */
  usage(tenantId: string) {
    return this.tenantDb.run(tenantId, async (tx) => {
      const [stores, devices, users, products] = await Promise.all([
        tx.store.count(),
        tx.device.count({ where: { revokedAt: null } }),
        tx.user.count({ where: { status: 'ACTIVE' } }),
        tx.product.count({ where: { hasVariants: false } }),
      ]);
      return { stores, devices, users, products };
    });
  }

  async tenantBilling(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, include: { plan: true } });
    const [usage, invoices] = await Promise.all([
      this.usage(tenantId),
      this.prisma.invoice.findMany({
        where: { tenantId }, orderBy: { periodStart: 'desc' }, take: 24,
        include: { payments: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, failureReason: true, createdAt: true } } },
      }),
    ]);
    const p = tenant.plan;
    return {
      onlinePayment: !!this.gateway,
      suspendedForBilling: tenant.status === 'SUSPENDED' && tenant.suspendedReason === 'billing',
      plan: { key: p.key, name: p.name, priceMonthly: p.priceMonthly, currency: p.currency },
      limits: { stores: p.maxStores, devices: p.maxDevices, users: p.maxUsers, products: p.maxProducts },
      usage,
      invoices: invoices.map(({ payments, ...i }) => ({ ...i, periodStart: day(i.periodStart), periodEnd: day(i.periodEnd), dueOn: day(i.dueOn), lastPayment: payments[0] ?? null })),
    };
  }

  // ── invoices ──
  async invoices(status?: 'DUE' | 'PAID' | 'VOID') {
    const rows = await this.prisma.invoice.findMany({ where: status ? { status } : {}, orderBy: [{ periodStart: 'desc' }, { number: 'asc' }], take: 500, include: { tenant: { select: { name: true, slug: true } } } });
    return rows.map((i) => ({ ...i, periodStart: day(i.periodStart), periodEnd: day(i.periodEnd), dueOn: day(i.dueOn) }));
  }

  /** Issues this month's invoice for every paying tenant that does not have one yet. */
  async issueMonthly(now = new Date()) {
    const start = monthStart(now);
    const tenants = await this.prisma.tenant.findMany({ where: { deletedAt: null, plan: { priceMonthly: { gt: 0 } } }, include: { plan: true } });
    let issued = 0;
    for (const t of tenants) {
      const exists = await this.prisma.invoice.findUnique({ where: { tenantId_periodStart: { tenantId: t.id, periodStart: start } } });
      if (exists) continue;
      await this.prisma.$transaction(async (tx) => {
        const inv = await tx.invoice.create({
          data: {
            tenantId: t.id, number: `INV-${day(start).slice(0, 7).replace('-', '')}-${t.slug}`, planKey: t.plan.key, periodStart: start, periodEnd: monthEnd(now),
            amount: t.plan.priceMonthly, currency: t.plan.currency, dueOn: addDays(start, 7),
          },
        });
        await this.audit.recordPlatform(tx, { ...SYSTEM, action: 'invoice.issued', entityType: 'Invoice', entityId: inv.id, after: { tenant: t.slug, amount: inv.amount } });
      });
      issued++;
    }
    return { issued };
  }

  /** Suspends tenants with an invoice unpaid past its due date plus the plan's grace days. */
  async enforceOverdue(now = new Date()) {
    const due = await this.prisma.invoice.findMany({ where: { status: 'DUE', dueOn: { lt: now } }, include: { tenant: { include: { plan: true } } } });
    let suspended = 0;
    for (const inv of due) {
      const t = inv.tenant;
      if (t.status !== 'ACTIVE' || addDays(inv.dueOn, t.plan.graceDays) >= now) continue;
      await this.prisma.$transaction(async (tx) => {
        await tx.tenant.update({ where: { id: t.id }, data: { status: 'SUSPENDED', suspendedReason: 'billing' } });
        await this.audit.recordPlatform(tx, { ...SYSTEM, action: 'tenant.suspended_overdue', entityType: 'Tenant', entityId: t.id, after: { invoice: inv.number } });
      });
      await this.resolver.invalidateTenant(t.id);
      suspended++;
    }
    return { suspended };
  }

  async markPaid(ctx: Ctx, id: string, reference: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id }, include: { tenant: true } });
    if (!inv) throw AppError.notFound('Invoice not found');
    if (inv.status !== 'DUE') throw new AppError('INVALID_STATE', 409, 'Only a due invoice can be marked paid');
    await this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({ where: { id }, data: { status: 'PAID', paidAt: new Date(), paidRef: reference } });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'invoice.paid', entityType: 'Invoice', entityId: id, after: { reference } });
      // Suspended for not paying, and now nothing is overdue: let them back in.
      const stillOverdue = await tx.invoice.count({ where: { tenantId: inv.tenantId, status: 'DUE', dueOn: { lt: new Date() }, id: { not: id } } });
      if (inv.tenant.status === 'SUSPENDED' && inv.tenant.suspendedReason === 'billing' && !stillOverdue) {
        await tx.tenant.update({ where: { id: inv.tenantId }, data: { status: 'ACTIVE', suspendedReason: null } });
        await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.reactivated_paid', entityType: 'Tenant', entityId: inv.tenantId });
      }
    });
    await this.resolver.invalidateTenant(inv.tenantId);
    return this.prisma.invoice.findUniqueOrThrow({ where: { id } });
  }

  // ── online payment ──

  /** Starts a hosted checkout for one of the tenant's due invoices; the browser goes to `url`. */
  async checkout(tenantId: string, invoiceId: string, userId: string, origin: string) {
    if (!this.gateway) throw new AppError('INVALID_STATE', 409, 'Online payment is not set up; pay by bank transfer');
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, tenantId }, include: { tenant: { select: { name: true } } } });
    if (!inv) throw AppError.notFound('Invoice not found');
    if (inv.status !== 'DUE') throw new AppError('INVALID_STATE', 409, 'This invoice is not due');
    const user = await this.tenantDb.run(tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, email: true } }));
    const session = await this.gateway.createCheckout({
      invoiceId: inv.id, invoiceNumber: inv.number, amount: inv.amount, currency: inv.currency, returnPath: '/billing', origin,
      payer: { name: user.name, email: user.email ?? '', business: inv.tenant.name },
    });
    await this.prisma.$transaction(async (tx) => {
      const pay = await tx.billingPayment.create({
        data: { tenantId, invoiceId: inv.id, provider: this.gateway!.key, sessionId: session.sessionId, amount: inv.amount, currency: inv.currency },
      });
      await this.audit.recordPlatform(tx, { ...GATEWAY, action: 'invoice.checkout_started', entityType: 'Invoice', entityId: inv.id, after: { paymentId: pay.id, userId, provider: pay.provider } });
    });
    return { url: session.url, ...(session.fields ? { fields: session.fields } : {}) };
  }

  /** A webhook from the gateway: verified, then applied once. */
  async webhook(provider: string, rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    if (!this.gateway || provider !== this.gateway.key) throw AppError.notFound();
    const event = rawBody ? this.gateway.parseWebhook(rawBody, headers) : null;
    if (!event) throw new AppError('UNAUTHENTICATED', 401, 'Webhook signature does not verify');
    return this.applyEvent(event);
  }

  /** What a checkout session turned into: paid (the invoice with it), or failed. Repeats change nothing. */
  async applyEvent(e: GatewayEvent) {
    const pay = await this.prisma.billingPayment.findUnique({ where: { sessionId: e.sessionId }, include: { invoice: true } });
    if (!pay) throw AppError.notFound('Unknown checkout session');
    if (pay.status !== 'PENDING' || e.status === 'PENDING') return { status: pay.status };
    const mismatch = e.status === 'SUCCEEDED' && (e.amount !== pay.amount || e.currency !== pay.currency);
    const ok = e.status === 'SUCCEEDED' && !mismatch;
    const reason = mismatch ? 'AMOUNT_MISMATCH' : (e.failureReason ?? null);
    const claimed = await this.prisma.$transaction(async (tx) => {
      const n = await tx.billingPayment.updateMany({
        where: { id: pay.id, status: 'PENDING' },
        data: { status: ok ? 'SUCCEEDED' : 'FAILED', providerRef: e.providerRef ?? null, failureReason: ok ? null : reason, completedAt: new Date() },
      });
      if (n.count !== 1) return false;
      await this.audit.recordPlatform(tx, {
        ...GATEWAY, action: ok ? 'invoice.payment_succeeded' : 'invoice.payment_failed', entityType: 'Invoice', entityId: pay.invoiceId,
        after: { paymentId: pay.id, provider: pay.provider, providerRef: e.providerRef ?? null, amount: e.amount, currency: e.currency, reason },
      });
      return true;
    });
    if (!claimed) return { status: (await this.prisma.billingPayment.findUniqueOrThrow({ where: { id: pay.id } })).status };
    if (ok) {
      const current = await this.prisma.invoice.findUniqueOrThrow({ where: { id: pay.invoiceId } });
      if (current.status === 'DUE') await this.markPaid(GATEWAY, pay.invoiceId, `${pay.provider}:${e.providerRef ?? pay.sessionId}`);
      else {
        // Paid twice (another attempt, or by hand meanwhile): flag it for a refund.
        await this.prisma.$transaction((tx) =>
          this.audit.recordPlatform(tx, { ...GATEWAY, action: 'invoice.paid_twice', entityType: 'Invoice', entityId: pay.invoiceId, after: { paymentId: pay.id, invoiceStatus: current.status } }),
        );
      }
    }
    return { status: ok ? 'SUCCEEDED' : 'FAILED' };
  }

  /** The sandbox page shows what is being paid. */
  async sandboxSession(sessionId: string) {
    const pay = await this.prisma.billingPayment.findUnique({ where: { sessionId }, include: { invoice: { select: { number: true } } } });
    if (!pay || pay.provider !== 'sandbox') throw AppError.notFound();
    return { status: pay.status, amount: pay.amount, currency: pay.currency, invoiceNumber: pay.invoice.number };
  }

  async voidInvoice(ctx: Ctx, id: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id } });
    if (!inv || inv.status !== 'DUE') throw new AppError('INVALID_STATE', 409, 'Only a due invoice can be voided');
    return this.prisma.$transaction(async (tx) => {
      await this.audit.recordPlatform(tx, { ...ctx, action: 'invoice.voided', entityType: 'Invoice', entityId: id });
      return tx.invoice.update({ where: { id }, data: { status: 'VOID' } });
    });
  }

  @Cron('0 2 * * *', { name: 'billing-daily', timeZone: 'Asia/Colombo' })
  async daily() {
    const a = await this.issueMonthly();
    const b = await this.enforceOverdue();
    this.logger.log(`Billing: ${a.issued} invoices issued, ${b.suspended} tenants suspended`);
  }
}
