import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

type Ctx = ReturnType<typeof auditContext>;

export const shiftNotOpen = () => new AppError('SHIFT_NOT_OPEN', 409, 'Open a shift on this register first');

export interface ShiftReport {
  shift: {
    id: string; registerId: string; storeId: string; status: string; openedAt: Date; closedAt: Date | null;
    openedById: string; closedById: string | null; openingFloat: number; countedCash: number | null; variance: number | null; note: string | null;
  };
  sales: { count: number; subtotal: number; discountTotal: number; taxTotal: number; total: number; rounding: number; tips: number };
  voids: { count: number; total: number };
  refunds: { count: number; total: number };
  payments: { method: string; amount: number }[];
  refundsByMethod: { method: string; amount: number }[];
  cash: { openingFloat: number; sales: number; refunds: number; payIns: number; payOuts: number; expected: number };
  movements: { type: string; amount: number; reason: string; createdAt: Date }[];
}

@Injectable()
export class ShiftsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  openShift(tx: Tx, registerId: string) {
    return tx.shift.findFirst({ where: { registerId, status: 'OPEN' } });
  }

  async requireOpenShift(tx: Tx, registerId: string) {
    const shift = await this.openShift(tx, registerId);
    if (!shift) throw shiftNotOpen();
    return shift;
  }

  /** Everything the drawer should hold and the Z report shows, computed from the ledgers. */
  async report(tx: Tx, shiftId: string): Promise<ShiftReport> {
    const shift = await tx.shift.findUnique({ where: { id: shiftId } });
    if (!shift) throw AppError.notFound('Shift not found');
    const [completed, voided, payments, refunds, movements] = await Promise.all([
      tx.sale.aggregate({
        where: { shiftId, status: 'COMPLETED' },
        _count: true,
        _sum: { subtotal: true, discountTotal: true, taxTotal: true, total: true, rounding: true, tip: true },
      }),
      tx.sale.aggregate({ where: { shiftId, status: 'VOIDED' }, _count: true, _sum: { due: true } }),
      tx.payment.groupBy({ by: ['method'], where: { sale: { shiftId, status: 'COMPLETED' } }, _sum: { amount: true } }),
      tx.refund.groupBy({ by: ['method'], where: { shiftId }, _count: true, _sum: { total: true, rounding: true } }),
      tx.cashMovement.findMany({ where: { shiftId }, orderBy: { createdAt: 'asc' } }),
    ]);
    const paid = (m: string) => payments.find((p) => p.method === m)?._sum.amount ?? 0;
    const refundOut = (r: (typeof refunds)[number]) => (r._sum.total ?? 0) + (r._sum.rounding ?? 0);
    const cashRefunds = refunds.filter((r) => r.method === 'CASH').reduce((s, r) => s + refundOut(r), 0);
    const payIns = movements.filter((m) => m.type === 'PAY_IN').reduce((s, m) => s + m.amount, 0);
    const payOuts = movements.filter((m) => m.type === 'PAY_OUT').reduce((s, m) => s + m.amount, 0);
    const cashSales = paid('CASH');
    return {
      shift: {
        id: shift.id, registerId: shift.registerId, storeId: shift.storeId, status: shift.status, openedAt: shift.openedAt, closedAt: shift.closedAt,
        openedById: shift.openedById, closedById: shift.closedById, openingFloat: shift.openingFloat, countedCash: shift.countedCash,
        variance: shift.variance, note: shift.note,
      },
      sales: {
        count: completed._count,
        subtotal: completed._sum.subtotal ?? 0,
        discountTotal: completed._sum.discountTotal ?? 0,
        taxTotal: completed._sum.taxTotal ?? 0,
        total: completed._sum.total ?? 0,
        rounding: completed._sum.rounding ?? 0,
        tips: completed._sum.tip ?? 0,
      },
      voids: { count: voided._count, total: voided._sum.due ?? 0 },
      refunds: { count: refunds.reduce((s, r) => s + r._count, 0), total: refunds.reduce((s, r) => s + refundOut(r), 0) },
      payments: payments.map((p) => ({ method: p.method, amount: p._sum.amount ?? 0 })),
      refundsByMethod: refunds.map((r) => ({ method: r.method, amount: refundOut(r) })),
      cash: {
        openingFloat: shift.openingFloat, sales: cashSales, refunds: cashRefunds, payIns, payOuts,
        expected: shift.openingFloat + cashSales - cashRefunds + payIns - payOuts,
      },
      movements: movements.map((m) => ({ type: m.type, amount: m.amount, reason: m.reason, createdAt: m.createdAt })),
    };
  }

  current(tenant: TenantContext, registerId: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const shift = await this.openShift(tx, registerId);
      return shift ? this.report(tx, shift.id) : null;
    });
  }

  open(tenant: TenantContext, registerId: string, userId: string, openingFloat: number, ctx: Ctx) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const register = await tx.register.findUnique({ where: { id: registerId } });
      if (!register) throw AppError.notFound('Register not found');
      if (await this.openShift(tx, registerId)) throw AppError.conflict('A shift is already open on this register');
      const shift = await tx.shift.create({ data: { tenantId: tenant.id, storeId: register.storeId, registerId, openedById: userId, openingFloat } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'shift.opened', entityType: 'Shift', entityId: shift.id, after: { openingFloat, registerId } });
      return this.report(tx, shift.id);
    });
  }

  cashMovement(
    tenant: TenantContext,
    registerId: string,
    userId: string,
    input: { type: 'PAY_IN' | 'PAY_OUT' | 'NO_SALE'; amount: number; reason: string },
    approvedById: string | null,
    ctx: Ctx,
  ) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const shift = await this.requireOpenShift(tx, registerId);
      const amount = input.type === 'NO_SALE' ? 0 : input.amount;
      if (input.type !== 'NO_SALE' && amount <= 0) throw AppError.validation([{ path: 'amount', message: 'Amount must be positive' }]);
      if (input.type === 'PAY_OUT') {
        const { cash } = await this.report(tx, shift.id);
        if (amount > cash.expected) throw new AppError('INVALID_STATE', 409, 'The drawer does not hold that much cash');
      }
      const m = await tx.cashMovement.create({
        data: { tenantId: tenant.id, shiftId: shift.id, type: input.type, amount, reason: input.reason, userId, approvedById },
      });
      await this.audit.record(tx, tenant.id, {
        ...ctx, action: `cash.${input.type.toLowerCase()}`, entityType: 'Shift', entityId: shift.id,
        after: { amount, reason: input.reason, approvedById },
      });
      return m;
    });
  }

  close(tenant: TenantContext, registerId: string, userId: string, input: { countedCash: number; note?: string }, approvedById: string | null, ctx: Ctx) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const shift = await this.requireOpenShift(tx, registerId);
      const before = await this.report(tx, shift.id);
      const variance = input.countedCash - before.cash.expected;
      await tx.shift.update({
        where: { id: shift.id },
        data: {
          status: 'CLOSED', closedAt: new Date(), closedById: userId, expectedCash: before.cash.expected,
          countedCash: input.countedCash, variance, note: input.note ?? null,
        },
      });
      await this.audit.record(tx, tenant.id, {
        ...ctx, action: 'shift.closed', entityType: 'Shift', entityId: shift.id,
        after: { expectedCash: before.cash.expected, countedCash: input.countedCash, variance, approvedById },
      });
      return this.report(tx, shift.id);
    });
  }

  list(tenant: TenantContext, q: { registerId?: string; storeId?: string }) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.shift.findMany({
        where: { ...(q.registerId ? { registerId: q.registerId } : {}), ...(q.storeId ? { storeId: q.storeId } : {}) },
        orderBy: { openedAt: 'desc' },
        take: 100,
        include: { register: { select: { code: true, name: true } } },
      }),
    );
  }

  get(tenant: TenantContext, id: string) {
    return this.tenantDb.run(tenant.id, (tx) => this.report(tx, id));
  }
}
