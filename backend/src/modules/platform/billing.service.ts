import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { PlanSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { TenantResolverService } from '../access/tenant-resolver.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

type Ctx = ReturnType<typeof platformAuditContext>;
const SYSTEM: Ctx = { actorId: null, ip: null, userAgent: null, correlationId: 'billing-job' };

const day = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * Plans and invoices. Each paying tenant gets one invoice per calendar month, due a week after the
 * month starts. Payment is recorded by a super admin (bank transfer and the like: integrated card
 * acquiring is out of scope). A tenant still unpaid `graceDays` after the due date is suspended,
 * and reactivated automatically once nothing is overdue.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly resolver: TenantResolverService,
    private readonly audit: AuditService,
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
    const [usage, invoices] = await Promise.all([this.usage(tenantId), this.prisma.invoice.findMany({ where: { tenantId }, orderBy: { periodStart: 'desc' }, take: 24 })]);
    const p = tenant.plan;
    return {
      plan: { key: p.key, name: p.name, priceMonthly: p.priceMonthly, currency: p.currency },
      limits: { stores: p.maxStores, devices: p.maxDevices, users: p.maxUsers, products: p.maxProducts },
      usage,
      invoices: invoices.map((i) => ({ ...i, periodStart: day(i.periodStart), periodEnd: day(i.periodEnd), dueOn: day(i.dueOn) })),
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
