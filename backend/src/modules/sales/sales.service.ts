import { Injectable } from '@nestjs/common';
import {
  cashRound, type CreateRefundSchema, type CreateSaleSchema, type Permission, type PricingLineInput,
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
import { AuditService } from '../audit/audit.service.js';
import { productInclude, taxStack } from '../catalog/catalog.service.js';
import { InventoryService, type StockChange } from '../inventory/inventory.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ShiftsService } from './shifts.service.js';

type SaleInput = z.infer<typeof CreateSaleSchema>;
type RefundInput = z.infer<typeof CreateRefundSchema>;
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

/** Exceeds the tenant's step-up threshold: amount / base > thresholdBp / 10000. */
const overThreshold = (amount: number, base: number, thresholdBp: number) => amount > 0 && amount * 10_000 > thresholdBp * base;

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
    await this.checkApprovals(req, perms, settings, input, byId, priced, approvals);

    const allCash = input.payments.every((p) => p.method === 'CASH');
    const due = allCash ? cashRound(priced.totals.total, settings.cashRoundingUnit) : priced.totals.total;
    if (input.expectedTotal !== due) {
      throw new AppError('TOTAL_MISMATCH', 409, 'The till and the server disagree on the total', { expected: input.expectedTotal, actual: due });
    }
    const paid = input.payments.reduce((s, p) => s + p.amount, 0);
    if (paid !== due) throw new AppError('PAYMENT_MISMATCH', 400, 'Payments must add up to the amount due', { due, paid });
    const payments = input.payments.map((p) => {
      if (p.method !== 'CASH') return { ...p, tendered: null, change: 0 };
      const tendered = p.tendered ?? p.amount;
      if (tendered < p.amount) throw new AppError('PAYMENT_MISMATCH', 400, 'Cash tendered is less than the amount', { amount: p.amount, tendered });
      return { ...p, tendered, change: tendered - p.amount };
    });

    return this.tenantDb.run(tenant.id, async (tx) => {
      const shift = await this.shifts.requireOpenShift(tx, device.registerId);
      const receiptNo = await this.nextReceiptNo(tx, device.registerId);
      await tx.sale.create({
        data: {
          id: input.id, tenantId: tenant.id, storeId: shift.storeId, registerId: device.registerId, shiftId: shift.id, deviceId: device.id,
          cashierId, receiptNo, pricesIncludeTax: settings.pricesIncludeTax,
          subtotal: priced.totals.subtotal, discountTotal: priced.totals.discountTotal, taxTotal: priced.totals.taxTotal, total: priced.totals.total,
          rounding: due - priced.totals.total, due, change: payments.reduce((s, p) => s + p.change, 0),
          taxes: json(priced.taxes), cartDiscount: input.cartDiscount ? json(input.cartDiscount) : Prisma.DbNull, approvals: json(approvals),
          soldAt: new Date(),
          lines: {
            create: priced.lines.map((l, i) => {
              const src = input.lines[i];
              const p = byId.get(src.productId)!;
              return {
                position: i, productId: p.id, name: p.name, sku: p.sku, unitPrice: pricingLines[i].unitPrice, listPrice: p.price,
                qtyMilli: src.qtyMilli, gross: l.gross, discount: l.discount, discounts: json(l.discounts), net: l.net, tax: l.tax,
                taxes: json(l.taxes), total: l.total, note: src.note ?? null,
              };
            }),
          },
          payments: {
            create: payments.map((p) => ({ method: p.method, amount: p.amount, tendered: p.tendered, change: p.change, reference: p.reference ?? null })),
          },
        },
      });
      const stock: StockChange[] = input.lines
        .filter((l) => byId.get(l.productId)!.trackStock)
        .map((l) => ({ storeId: shift.storeId, productId: l.productId, deltaMilli: -l.qtyMilli, reason: 'SALE', refType: 'Sale', refId: input.id, userId: cashierId }));
      await this.inventory.apply(tx, tenant.id, stock);
      await this.audit.record(tx, tenant.id, {
        ...auditContext(req), action: 'sale.completed', entityType: 'Sale', entityId: input.id,
        after: { receiptNo, total: priced.totals.total, due, lines: input.lines.length, approvals },
      });
      return (await this.getSale(tx, input.id))!;
    });
  }

  private async checkApprovals(
    req: RequestWithContext,
    perms: Set<Permission>,
    settings: TenantSettings,
    input: SaleInput,
    products: Map<string, { price: number }>,
    priced: ReturnType<typeof priceSale>,
    out: Approval[],
  ) {
    const threshold = settings.stepUp.discountAboveBp;
    if (input.lines.some((l) => l.unitPrice !== undefined && l.unitPrice !== products.get(l.productId)!.price)) {
      // Price overrides always need a manager, even for staff who hold price.override themselves.
      await this.authorize(req, perms, 'price.override', true, out);
    }
    let lineDiscountOver = false;
    let anyDiscount = false;
    input.lines.forEach((l, i) => {
      if (!l.discount) return;
      anyDiscount = true;
      const pl = priced.lines[i];
      if (overThreshold(pl.discounts[0] ?? 0, pl.gross, threshold)) lineDiscountOver = true;
    });
    let cartOver = false;
    if (input.cartDiscount) {
      anyDiscount = true;
      const cartAmount = priced.lines.reduce((s, l) => s + (l.discounts[l.discounts.length - 1] ?? 0), 0);
      const base = priced.lines.reduce((s, l, i) => s + l.gross - (input.lines[i].discount ? (l.discounts[0] ?? 0) : 0), 0);
      cartOver = overThreshold(cartAmount, base, threshold);
    }
    if (anyDiscount) await this.authorize(req, perms, 'discount.apply', lineDiscountOver || cartOver, out);
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
      // Optimistic lock on each line: amounts were computed against refundedBefore, so a concurrent refund aborts this one.
      for (const l of lines) {
        const updated = await tx.saleLine.updateMany({
          where: { id: l.saleLineId, refundedQtyMilli: l.refundedBefore },
          data: { refundedQtyMilli: { increment: l.qtyMilli } },
        });
        if (updated.count !== 1) throw AppError.conflict('This line was refunded meanwhile; reload the sale');
      }
      if (input.method === 'CASH') {
        const { cash } = await this.shifts.report(tx, shift.id);
        if (paidOut > cash.expected) throw new AppError('INVALID_STATE', 409, 'The drawer does not hold enough cash for this refund');
      }
      const receiptNo = await this.nextReceiptNo(tx, device.registerId, 'R');
      const refund = await tx.refund.create({
        data: {
          id: input.id, tenantId: tenant.id, saleId: sale.id, storeId: shift.storeId, registerId: device.registerId, shiftId: shift.id,
          deviceId: device.id, userId, approvedById, receiptNo, method: input.method, reason: input.reason, restock: input.restock,
          total, taxTotal, rounding: paidOut - total,
          lines: { create: lines.map((l) => ({ saleLineId: l.saleLineId, qtyMilli: l.qtyMilli, net: l.net, tax: l.tax, total: l.total })) },
        },
        include: { lines: true },
      });
      if (input.restock) {
        const tracked = await tx.product.findMany({ where: { id: { in: lines.map((l) => l.productId) }, trackStock: true }, select: { id: true } });
        const trackedIds = new Set(tracked.map((p) => p.id));
        await this.inventory.apply(
          tx, tenant.id,
          lines.filter((l) => trackedIds.has(l.productId)).map((l) => ({
            storeId: shift.storeId, productId: l.productId, deltaMilli: l.qtyMilli, reason: 'REFUND', refType: 'Refund', refId: refund.id, userId,
          })),
        );
      }
      await this.audit.record(tx, tenant.id, {
        ...auditContext(req), action: 'sale.refunded', entityType: 'Sale', entityId: sale.id,
        after: { refundId: refund.id, receiptNo, total, paidOut, method: input.method, reason: input.reason, approvedById },
      });
      return refund;
    });
  }

  /**
   * Money per refunded line, proportional to the original line. Refunding what is left of a line
   * takes exactly what is left, so a line refunded in parts never refunds a minor unit more or less.
   */
  private refundLines(sale: SaleWithLines, input: RefundInput) {
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

