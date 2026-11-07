import { Injectable } from '@nestjs/common';
import {
  approvalNeeds, cashRound, type CreateRefundSchema, type CreateSaleSchema, type Discount, type PaymentMethodKey, type Permission, type PricingResult, type PricingLineInput,
  priceSale, prorate, type TenantSettings,
} from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext, TenantContext } from '../../common/request-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import { StepUpGate } from '../access/step-up-gate.js';
import { auditContext } from '../audit/audit-context.js';
import { type AuditEntry, AuditService } from '../audit/audit.service.js';
import { productInclude, taxStack } from '../catalog/catalog.service.js';
import { InventoryService, type StockChange } from '../inventory/inventory.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ShiftsService } from './shifts.service.js';

type SaleInput = z.infer<typeof CreateSaleSchema>;
type RefundInput = z.infer<typeof CreateRefundSchema>;
export { approvalNeeds };

export interface Approval {
  action: Permission;
  approverId: string;
}

export const saleInclude = {
  lines: { orderBy: { position: 'asc' } },
  payments: true,
  refunds: { select: { id: true, receiptNo: true, total: true, rounding: true, method: true, createdAt: true } },
} as const satisfies Prisma.SaleInclude;
export type SaleWithLines = Prisma.SaleGetPayload<{ include: typeof saleInclude }>;

const json = (v: unknown) => v as Prisma.InputJsonValue;
const pad = (n: number) => String(n).padStart(6, '0');


export interface RefundLineCalc {
  saleLineId: string;
  productId: string;
  qtyMilli: number;
  refundedBefore: number;
  net: number;
  tax: number;
  total: number;
}

export interface RefundRecord {
  id: string;
  saleId: string;
  storeId: string;
  registerId: string;
  shiftId: string;
  deviceId: string;
  userId: string;
  approvedById: string | null;
  receiptNo: string;
  method: PaymentMethodKey;
  reason: string;
  restock: boolean;
  lines: RefundLineCalc[];
  total: number;
  taxTotal: number;
  paidOut: number;
  offline: boolean;
  /** Online refunds check the drawer holds the cash; offline ones are facts already paid out. */
  checkDrawer: boolean;
}

export interface SettledPayment {
  method: PaymentMethodKey;
  amount: number;
  tendered: number | null;
  change: number;
  reference?: string;
}

export interface SaleRecord {
  id: string;
  storeId: string;
  registerId: string;
  shiftId: string;
  deviceId: string;
  cashierId: string;
  receiptNo: string;
  pricesIncludeTax: boolean;
  priced: PricingResult;
  due: number;
  payments: SettledPayment[];
  cartDiscount?: Discount;
  approvals: Approval[];
  soldAt: Date;
  offline: boolean;
  catalogVersion: bigint | null;
  lines: { productId: string; name: string; sku: string | null; unitPrice: number; listPrice: number; qtyMilli: number; note?: string; trackStock: boolean }[];
}

/** Payments must add up to the amount due exactly; cash may be over-tendered and gives change. */
export function settlePayments(payments: { method: PaymentMethodKey; amount: number; tendered?: number; reference?: string }[], due: number): SettledPayment[] {
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  if (paid !== due) throw new AppError('PAYMENT_MISMATCH', 400, 'Payments must add up to the amount due', { due, paid });
  return payments.map((p) => {
    if (p.method !== 'CASH') return { ...p, tendered: null, change: 0 };
    const tendered = p.tendered ?? p.amount;
    if (tendered < p.amount) throw new AppError('PAYMENT_MISMATCH', 400, 'Cash tendered is less than the amount', { amount: p.amount, tendered });
    return { ...p, tendered, change: tendered - p.amount };
  });
}

@Injectable()
export class SalesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly settings: SettingsService,
    private readonly capabilities: CapabilitiesService,
    private readonly gate: StepUpGate,
    private readonly shifts: ShiftsService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  /** The cashier's own permission is enough unless the action crosses a threshold; otherwise a manager approves. */
  private async authorize(req: RequestWithContext, perms: Set<Permission>, action: Permission, needsApproval: boolean, out: Approval[]) {
    if (perms.has(action) && !needsApproval) return;
    if (out.some((a) => a.action === action)) return;
    out.push({ action, approverId: await this.gate.require(req, action) });
  }

  private async nextReceiptNo(tx: Tx, registerId: string, prefix = '') {
    const r = await tx.register.update({ where: { id: registerId }, data: { receiptSeq: { increment: 1 } }, select: { code: true, receiptSeq: true } });
    return `${prefix}${r.code}-${pad(r.receiptSeq)}`;
  }

  getSale(tx: Tx, id: string) {
    return tx.sale.findUnique({ where: { id }, include: saleInclude });
  }

  async create(req: RequestWithContext, input: SaleInput): Promise<SaleWithLines> {
    const tenant = req.tenant!;
    const device = req.device!;
    const cashierId = req.principal!.userId;
    try {
      return await this.createOnce(req, tenant, device, cashierId, input);
    } catch (e) {
      // Two submissions of the same sale raced: the loser returns the winner's row.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.tenantDb.run(tenant.id, (tx) => this.getSale(tx, input.id));
        if (existing) return existing;
      }
      throw e;
    }
  }

  private async createOnce(
    req: RequestWithContext,
    tenant: TenantContext,
    device: { id: string; registerId: string },
    cashierId: string,
    input: SaleInput,
  ): Promise<SaleWithLines> {
    const existing = await this.tenantDb.run(tenant.id, (tx) => this.getSale(tx, input.id));
    if (existing) return existing;

    const [settings, perms] = await Promise.all([this.settings.get(tenant.id), this.capabilities.permissionsFor(tenant.id, cashierId)]);
    const products = await this.tenantDb.run(tenant.id, (tx) =>
      tx.product.findMany({ where: { id: { in: [...new Set(input.lines.map((l) => l.productId))] }, active: true }, include: productInclude }),
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    const missing = input.lines.filter((l) => !byId.has(l.productId)).map((l) => l.productId);
    if (missing.length) throw new AppError('NOT_FOUND', 404, 'Product not found or inactive', { productIds: [...new Set(missing)] });

    const pricingLines: PricingLineInput[] = input.lines.map((l, i) => {
      const p = byId.get(l.productId)!;
      return {
        key: String(i),
        unitPrice: l.unitPrice ?? p.price,
        qtyMilli: l.qtyMilli,
        taxes: taxStack(p.taxGroup),
        discounts: l.discount ? [l.discount] : [],
      };
    });
    const priced = priceSale({ pricesIncludeTax: settings.pricesIncludeTax, lines: pricingLines, cartDiscounts: input.cartDiscount ? [input.cartDiscount] : [] });

    const approvals: Approval[] = [];
    const saleLines = input.lines.map((l) => ({ ...l, listPrice: byId.get(l.productId)!.price, unitPrice: l.unitPrice ?? byId.get(l.productId)!.price }));
    for (const n of approvalNeeds(perms, settings, saleLines, input.cartDiscount, priced)) await this.authorize(req, perms, n.action, n.force, approvals);

    const allCash = input.payments.every((p) => p.method === 'CASH');
    const due = allCash ? cashRound(priced.totals.total, settings.cashRoundingUnit) : priced.totals.total;
    if (input.expectedTotal !== due) {
      throw new AppError('TOTAL_MISMATCH', 409, 'The till and the server disagree on the total', { expected: input.expectedTotal, actual: due });
    }
    const payments = settlePayments(input.payments, due);

    return this.tenantDb.run(tenant.id, async (tx) => {
      const shift = await this.shifts.requireOpenShift(tx, device.registerId);
      const receiptNo = await this.nextReceiptNo(tx, device.registerId);
      await this.persistSale(tx, tenant.id, {
        id: input.id, storeId: shift.storeId, registerId: device.registerId, shiftId: shift.id, deviceId: device.id, cashierId, receiptNo,
        pricesIncludeTax: settings.pricesIncludeTax, priced, due, payments, cartDiscount: input.cartDiscount, approvals, soldAt: new Date(),
        offline: false, catalogVersion: null,
        lines: input.lines.map((l) => {
          const p = byId.get(l.productId)!;
          return { productId: p.id, name: p.name, sku: p.sku, unitPrice: l.unitPrice ?? p.price, listPrice: p.price, qtyMilli: l.qtyMilli, note: l.note, trackStock: p.trackStock };
        }),
      }, auditContext(req));
      return (await this.getSale(tx, input.id))!;
    });
  }

  /** Writes a priced, paid sale with its lines, payments, stock movements and audit event. */
  async persistSale(tx: Tx, tenantId: string, r: SaleRecord, ctx: Partial<AuditEntry>) {
    await tx.sale.create({
      data: {
        id: r.id, tenantId, storeId: r.storeId, registerId: r.registerId, shiftId: r.shiftId, deviceId: r.deviceId,
        cashierId: r.cashierId, receiptNo: r.receiptNo, pricesIncludeTax: r.pricesIncludeTax,
        subtotal: r.priced.totals.subtotal, discountTotal: r.priced.totals.discountTotal, taxTotal: r.priced.totals.taxTotal, total: r.priced.totals.total,
        rounding: r.due - r.priced.totals.total, due: r.due, change: r.payments.reduce((s, p) => s + p.change, 0),
        taxes: json(r.priced.taxes), cartDiscount: r.cartDiscount ? json(r.cartDiscount) : Prisma.DbNull, approvals: json(r.approvals),
        soldAt: r.soldAt, offline: r.offline, catalogVersion: r.catalogVersion,
        lines: {
          create: r.priced.lines.map((l, i) => {
            const src = r.lines[i];
            return {
              position: i, productId: src.productId, name: src.name, sku: src.sku, unitPrice: src.unitPrice, listPrice: src.listPrice,
              qtyMilli: src.qtyMilli, gross: l.gross, discount: l.discount, discounts: json(l.discounts), net: l.net, tax: l.tax,
              taxes: json(l.taxes), total: l.total, note: src.note ?? null,
            };
          }),
        },
        payments: {
          create: r.payments.map((p) => ({ method: p.method, amount: p.amount, tendered: p.tendered, change: p.change, reference: p.reference ?? null })),
        },
      },
    });
    await this.inventory.apply(
      tx, tenantId,
      r.lines.filter((l) => l.trackStock).map((l) => ({
        storeId: r.storeId, productId: l.productId, deltaMilli: -l.qtyMilli, reason: 'SALE' as const, refType: 'Sale', refId: r.id, userId: r.cashierId,
      })),
    );
    await this.audit.record(tx, tenantId, {
      ...ctx, action: 'sale.completed', entityType: 'Sale', entityId: r.id,
      after: { receiptNo: r.receiptNo, total: r.priced.totals.total, due: r.due, lines: r.lines.length, approvals: r.approvals, ...(r.offline ? { offline: true } : {}) },
    });
  }

  /** Voids are only allowed while the sale's shift is still open on this register. */
  async void(req: RequestWithContext, saleId: string, reason: string): Promise<SaleWithLines> {
    const tenant = req.tenant!;
    const device = req.device!;
    const approverId = req.stepUpApprovals?.['sale.void'] ?? null;
    return this.tenantDb.run(tenant.id, async (tx) => {
      const sale = await this.getSale(tx, saleId);
      if (!sale) throw AppError.notFound('Sale not found');
      if (sale.status !== 'COMPLETED') throw new AppError('INVALID_STATE', 409, 'This sale is already voided');
      if (sale.refunds.length) throw new AppError('INVALID_STATE', 409, 'A sale with refunds cannot be voided; refund the rest instead');
      const shift = await this.shifts.requireOpenShift(tx, device.registerId);
      if (sale.shiftId !== shift.id) throw new AppError('INVALID_STATE', 409, 'Only sales from the current shift on this register can be voided');

      await tx.sale.update({ where: { id: saleId }, data: { status: 'VOIDED', voidedAt: new Date(), voidedById: req.principal!.userId, voidReason: reason } });
      const tracked = await tx.product.findMany({ where: { id: { in: sale.lines.map((l) => l.productId) }, trackStock: true }, select: { id: true } });
      const trackedIds = new Set(tracked.map((p) => p.id));
      await this.inventory.apply(
        tx, tenant.id,
        sale.lines.filter((l) => trackedIds.has(l.productId)).map((l) => ({
          storeId: sale.storeId, productId: l.productId, deltaMilli: l.qtyMilli, reason: 'VOID', refType: 'Sale', refId: sale.id, userId: req.principal!.userId,
        })),
      );
      await this.audit.record(tx, tenant.id, {
        ...auditContext(req), action: 'sale.voided', entityType: 'Sale', entityId: sale.id,
        before: { status: 'COMPLETED' }, after: { status: 'VOIDED', reason, approverId },
      });
      return (await this.getSale(tx, saleId))!;
    });
  }

  async refund(req: RequestWithContext, input: RefundInput) {
    const tenant = req.tenant!;
    const device = req.device!;
    const userId = req.principal!.userId;

    const existing = await this.tenantDb.run(tenant.id, (tx) => tx.refund.findUnique({ where: { id: input.id }, include: { lines: true } }));
    if (existing) return existing;

    const [settings, perms] = await Promise.all([this.settings.get(tenant.id), this.capabilities.permissionsFor(tenant.id, userId)]);
    const sale = await this.tenantDb.run(tenant.id, (tx) => this.getSale(tx, input.saleId));
    if (!sale) throw AppError.notFound('Sale not found');
    if (sale.status !== 'COMPLETED') throw new AppError('INVALID_STATE', 409, 'Voided sales cannot be refunded');

    const lines = this.refundLines(sale, input);
    const total = lines.reduce((s, l) => s + l.total, 0);
    const taxTotal = lines.reduce((s, l) => s + l.tax, 0);
    const paidOut = input.method === 'CASH' ? cashRound(total, settings.cashRoundingUnit) : total;

    const approvals: Approval[] = [];
    await this.authorize(req, perms, 'sale.refund', total > settings.stepUp.refundAbove, approvals);
    const approvedById = approvals[0]?.approverId ?? null;

    return this.tenantDb.run(tenant.id, async (tx) => {
      const shift = await this.shifts.requireOpenShift(tx, device.registerId);
      const receiptNo = await this.nextReceiptNo(tx, device.registerId, 'R');
      return this.persistRefund(tx, tenant.id, {
        id: input.id, saleId: sale.id, storeId: shift.storeId, registerId: device.registerId, shiftId: shift.id, deviceId: device.id,
        userId, approvedById, receiptNo, method: input.method, reason: input.reason, restock: input.restock, lines, total, taxTotal, paidOut,
        offline: false, checkDrawer: true,
      }, auditContext(req));
    });
  }

  /** Writes a refund: locks and bumps the refunded quantities, restocks, audits. */
  async persistRefund(tx: Tx, tenantId: string, r: RefundRecord, ctx: Partial<AuditEntry>) {
    // Optimistic lock on each line: amounts were computed against refundedBefore, so a concurrent refund aborts this one.
    for (const l of r.lines) {
      const updated = await tx.saleLine.updateMany({
        where: { id: l.saleLineId, refundedQtyMilli: l.refundedBefore },
        data: { refundedQtyMilli: { increment: l.qtyMilli } },
      });
      if (updated.count !== 1) throw AppError.conflict('This line was refunded meanwhile; reload the sale');
    }
    if (r.checkDrawer && r.method === 'CASH') {
      const { cash } = await this.shifts.report(tx, r.shiftId);
      if (r.paidOut > cash.expected) throw new AppError('INVALID_STATE', 409, 'The drawer does not hold enough cash for this refund');
    }
    const refund = await tx.refund.create({
      data: {
        id: r.id, tenantId, saleId: r.saleId, storeId: r.storeId, registerId: r.registerId, shiftId: r.shiftId,
        deviceId: r.deviceId, userId: r.userId, approvedById: r.approvedById, receiptNo: r.receiptNo, method: r.method, reason: r.reason,
        restock: r.restock, total: r.total, taxTotal: r.taxTotal, rounding: r.paidOut - r.total, offline: r.offline,
        lines: { create: r.lines.map((l) => ({ saleLineId: l.saleLineId, qtyMilli: l.qtyMilli, net: l.net, tax: l.tax, total: l.total })) },
      },
      include: { lines: true },
    });
    if (r.restock) {
      const tracked = await tx.product.findMany({ where: { id: { in: r.lines.map((l) => l.productId) }, trackStock: true }, select: { id: true } });
      const trackedIds = new Set(tracked.map((p) => p.id));
      await this.inventory.apply(
        tx, tenantId,
        r.lines.filter((l) => trackedIds.has(l.productId)).map((l) => ({
          storeId: r.storeId, productId: l.productId, deltaMilli: l.qtyMilli, reason: 'REFUND' as const, refType: 'Refund', refId: refund.id, userId: r.userId,
        })),
      );
    }
    await this.audit.record(tx, tenantId, {
      ...ctx, action: 'sale.refunded', entityType: 'Sale', entityId: r.saleId,
      after: {
        refundId: refund.id, receiptNo: r.receiptNo, total: r.total, paidOut: r.paidOut, method: r.method, reason: r.reason,
        approvedById: r.approvedById, ...(r.offline ? { offline: true } : {}),
      },
    });
    return refund;
  }

  /**
   * Money per refunded line, proportional to the original line. Refunding what is left of a line
   * takes exactly what is left, so a line refunded in parts never refunds a minor unit more or less.
   */
  refundLines(sale: SaleWithLines, input: Pick<RefundInput, 'lines'>): RefundLineCalc[] {
    const byId = new Map(sale.lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    return input.lines.map((r) => {
      const line = byId.get(r.saleLineId);
      if (!line) throw AppError.notFound('Sale line not found on this sale');
      if (seen.has(line.id)) throw AppError.validation([{ path: 'lines', message: 'Each line may appear once' }]);
      seen.add(line.id);
      const remaining = line.qtyMilli - line.refundedQtyMilli;
      if (r.qtyMilli > remaining) throw new AppError('INVALID_STATE', 409, 'Refund exceeds the quantity left on the line', { saleLineId: line.id, remaining });
      const share = (whole: number) => {
        const done = prorate(whole, line.refundedQtyMilli, line.qtyMilli);
        return prorate(whole, line.refundedQtyMilli + r.qtyMilli, line.qtyMilli) - done;
      };
      return {
        saleLineId: line.id, productId: line.productId, qtyMilli: r.qtyMilli, refundedBefore: line.refundedQtyMilli,
        net: share(line.net), tax: share(line.tax), total: share(line.total),
      };
    });
  }

  recentForRegister(tenant: TenantContext, registerId: string) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.sale.findMany({
        where: { registerId },
        orderBy: { soldAt: 'desc' },
        take: 30,
        select: { id: true, receiptNo: true, status: true, total: true, due: true, soldAt: true, cashierId: true },
      }),
    );
  }

  findByReceipt(tenant: TenantContext, receiptNo: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const s = await tx.sale.findUnique({ where: { tenantId_receiptNo: { tenantId: tenant.id, receiptNo } }, include: saleInclude });
      if (!s) throw AppError.notFound('No sale with that receipt number');
      return s;
    });
  }

  get(tenant: TenantContext, id: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const s = await this.getSale(tx, id);
      if (!s) throw AppError.notFound('Sale not found');
      return s;
    });
  }

  list(tenant: TenantContext, q: { from?: Date; to?: Date; registerId?: string; storeId?: string; receiptNo?: string; take?: number }) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.sale.findMany({
        where: {
          ...(q.receiptNo ? { receiptNo: { contains: q.receiptNo, mode: 'insensitive' } } : {}),
          ...(q.registerId ? { registerId: q.registerId } : {}),
          ...(q.storeId ? { storeId: q.storeId } : {}),
          ...(q.from || q.to ? { soldAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lt: q.to } : {}) } } : {}),
        },
        orderBy: { soldAt: 'desc' },
        take: Math.min(q.take ?? 100, 500),
        select: { id: true, receiptNo: true, status: true, total: true, due: true, soldAt: true, cashierId: true, registerId: true, storeId: true },
      }),
    );
  }
}

