import { Injectable } from '@nestjs/common';
import { type CustomerSchema, normalizePhone, type UpdateCustomerSchema } from '@pos/shared';
import type { z } from 'zod';
import { Aead } from '../../common/crypto/aead.js';
import { BlindIndex } from '../../common/crypto/blind-index.js';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { type LedgerKind, LedgersService } from './ledgers.service.js';

type Ctx = ReturnType<typeof auditContext>;
type Row = Prisma.CustomerGetPayload<object>;

const COUNTRY_CODES: Record<string, string> = { LK: '94', IN: '91', GB: '44', US: '1', AU: '61', AE: '971', SG: '65', MV: '960' };

export interface CustomerView {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  createdAt: Date;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly aead: Aead,
    private readonly index: BlindIndex,
    private readonly ledgers: LedgersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private async phoneKey(tenantId: string, phone: string) {
    const { country } = await this.settings.profile(tenantId);
    return normalizePhone(phone, COUNTRY_CODES[country] ?? '94');
  }

  /** Encrypted columns and their blind indexes, scoped by tenant so equal phones in two tenants differ. */
  private async sealed(tenantId: string, input: { phone?: string | null; email?: string | null }) {
    const out: Record<string, string | null> = {};
    if (input.phone !== undefined) {
      const p = input.phone ? await this.phoneKey(tenantId, input.phone) : null;
      out['phoneEnc'] = p ? this.aead.encrypt(p) : null;
      out['phoneIdx'] = p ? this.index.of(`${tenantId}:phone:${p}`) : null;
      out['phoneLast4'] = p ? p.slice(-4) : null;
    }
    if (input.email !== undefined) {
      out['emailEnc'] = input.email ? this.aead.encrypt(input.email) : null;
      out['emailIdx'] = input.email ? this.index.of(`${tenantId}:email:${input.email}`) : null;
    }
    return out;
  }

  view(r: Row): CustomerView {
    return {
      id: r.id, name: r.name,
      phone: r.phoneEnc ? `+${this.aead.decrypt(r.phoneEnc)}` : null,
      email: r.emailEnc ? this.aead.decrypt(r.emailEnc) : null,
      notes: r.notes, createdAt: r.createdAt,
    };
  }

  /** What a till sees: no full phone or email, just enough to confirm the right person. */
  tillView(r: Row, balances: { points: number; credit: number }) {
    return { id: r.id, name: r.name, phoneLast4: r.phoneLast4, ...balances };
  }

  async create(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof CustomerSchema>) {
    const sealed = await this.sealed(tenant.id, input);
    return this.tenantDb.run(tenant.id, async (tx) => {
      if (sealed['phoneIdx'] && (await tx.customer.count({ where: { phoneIdx: sealed['phoneIdx'] } }))) {
        throw AppError.conflict('A customer with that phone number already exists');
      }
      const c = await tx.customer.create({ data: { tenantId: tenant.id, name: input.name, notes: input.notes ?? null, ...sealed } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'customer.created', entityType: 'Customer', entityId: c.id, after: { name: input.name } });
      return this.view(c);
    });
  }

  async update(tenant: TenantContext, ctx: Ctx, id: string, input: z.infer<typeof UpdateCustomerSchema>) {
    const sealed = await this.sealed(tenant.id, input);
    return this.tenantDb.run(tenant.id, async (tx) => {
      const before = await tx.customer.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Customer not found');
      const c = await tx.customer.update({
        where: { id },
        data: { ...(input.name ? { name: input.name } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}), ...sealed },
      });
      // PII is not copied into the audit log, only which fields changed.
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'customer.updated', entityType: 'Customer', entityId: id, after: { fields: Object.keys(input) } });
      return this.view(c);
    });
  }

  /** Exact phone (via the blind index) or a name fragment. */
  async search(tenant: TenantContext, q: string, take = 20) {
    const query = q.trim();
    if (!query) return [];
    const digits = query.replace(/[^0-9]/g, '');
    const phoneIdx = digits.length >= 7 ? this.index.of(`${tenant.id}:phone:${await this.phoneKey(tenant.id, query)}`) : null;
    return this.tenantDb.run(tenant.id, async (tx) => {
      const rows = await tx.customer.findMany({
        where: { OR: [...(phoneIdx ? [{ phoneIdx }] : []), { name: { contains: query, mode: 'insensitive' } }] },
        orderBy: { name: 'asc' },
        take,
      });
      return Promise.all(rows.map(async (r) => ({ row: r, balances: await this.balances(tx, r.id) })));
    });
  }

  async balances(tx: Tx, customerId: string) {
    const [points, credit] = await Promise.all([this.ledgers.balance(tx, 'loyalty', customerId), this.ledgers.balance(tx, 'credit', customerId)]);
    return { points, credit };
  }

  list(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const rows = await tx.customer.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
      return rows.map((r) => ({ id: r.id, name: r.name, phoneLast4: r.phoneLast4, createdAt: r.createdAt }));
    });
  }

  async get(tenant: TenantContext, id: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const r = await tx.customer.findUnique({ where: { id } });
      if (!r) throw AppError.notFound('Customer not found');
      const [balances, sales, loyaltyLedger, creditLedger] = await Promise.all([
        this.balances(tx, id),
        tx.sale.findMany({ where: { customerId: id }, orderBy: { soldAt: 'desc' }, take: 50, select: { id: true, receiptNo: true, due: true, status: true, soldAt: true, loyaltyEarned: true } }),
        tx.loyaltyLedger.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
        tx.storeCreditLedger.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      ]);
      return { customer: this.view(r), ...balances, sales, loyaltyLedger, creditLedger };
    });
  }

  async findForTill(tx: Tx, id: string) {
    return tx.customer.findUnique({ where: { id } });
  }

  adjust(tenant: TenantContext, ctx: Ctx, id: string, kind: LedgerKind, delta: number, reason: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      if (!(await tx.customer.findUnique({ where: { id } }))) throw AppError.notFound('Customer not found');
      await this.ledgers.lock(tx, id);
      const before = await this.ledgers.balance(tx, kind, id);
      if (before + delta < 0) throw new AppError('INVALID_STATE', 409, 'Balance cannot go below zero', { balance: before });
      await this.ledgers.add(tx, tenant.id, kind, { customerId: id, delta, reason: 'ADJUST', note: reason, userId: ctx.actorUserId });
      await this.audit.record(tx, tenant.id, {
        ...ctx, action: kind === 'loyalty' ? 'loyalty.adjusted' : 'store_credit.adjusted', entityType: 'Customer', entityId: id,
        before: { balance: before }, after: { balance: before + delta, delta, reason },
      });
      return this.balances(tx, id);
    });
  }
}
