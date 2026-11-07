import { Injectable } from '@nestjs/common';
import {
  approvalNeeds, type BatchTake, type CardResult, cashRound, chooseModifiers, type CreateRefundSchema, type CreateSaleSchema, type Discount, type ModuleKey, type PaymentMethodKey, type Permission,
  pointsEarned, priceWithPromotions, type PricingResult, prorate, type TenantSettings, withModifiers,
} from '@pos/shared';
import { ModifiersService } from '../restaurant/modifiers.service.js';
import { BatchesService } from '../pharmacy/batches.service.js';
import { PrescriptionsService } from '../pharmacy/prescriptions.service.js';
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
import { productInclude, storePrices, taxStack } from '../catalog/catalog.service.js';
import { LedgersService } from '../customers/ledgers.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { PromotionsService } from '../promotions/promotions.service.js';
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
  card?: CardResult | null;
}

export interface VoidRecord {
  saleId: string;
  userId: string;
  reason: string;
  approverId: string | null;
  at: Date;
  /** The offline op that voided it. */
  opId?: string | null;
}

export interface SettledPayment {
  method: PaymentMethodKey;
  amount: number;
  tendered: number | null;
  change: number;
  reference?: string;
  card?: CardResult;
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
  customerId?: string | null;
  /** Promotions applied, summed per promotion. */
  promotions?: AppliedPromotion[];
  /** Set when the loyalty module is on: how points are earned and what they are worth. */
  loyalty?: TenantSettings['loyalty'] | null;
  tip?: number;
  /** Batch-expiry on: lines of products that track lots take stock first-expiring-first. */
  batchesOn?: boolean;
  /** Prescriptions on: days a prescription stays valid. */
  rxValidDays?: number | null;
  /** Paying (part of) an open order: which order lines and how much of each. */
  orderPay?: { orderId: string; lines: { orderLineId: string; qtyMilli: number }[] } | null;
  /** A manager accepted an offline sale that spent more points or credit than the customer had. */
  allowOverdraw?: boolean;
  lines: {
    /** Offline sales choose their line ids so they can be refunded before they sync. */
    id?: string;
    productId: string; name: string; sku: string | null; unitPrice: number; listPrice: number; qtyMilli: number; note?: string; trackStock: boolean;
    modifiers?: { id: string; name: string; priceDelta: number }[]; orderLineId?: string | null;
    tracksBatches?: boolean; rxRequired?: boolean; prescriptionItemId?: string | null; unitCost?: number;
  }[];
}

export interface AppliedPromotion {
  promotionId: string;
  label: string;
  amount: number;
}

/** Promotion amounts out of the priced sale, one entry per promotion. */
export function appliedPromotions(priced: PricingResult, ids: Map<string, string>): AppliedPromotion[] {
  const byLabel = new Map<string, number>();
  for (const l of priced.lines) for (const p of l.parts) if (p.source === 'promo' && p.label) byLabel.set(p.label, (byLabel.get(p.label) ?? 0) + p.amount);
  return [...byLabel].map(([label, amount]) => ({ promotionId: ids.get(label) ?? '', label, amount }));
}

/** Points and store credit need the customer on the sale and the right modules. */
export function checkTenderRules(payments: { method: PaymentMethodKey; amount: number }[], customerId: string | undefined | null, modules: ModuleKey[], settings: TenantSettings) {
  for (const p of payments) {
    if (p.method === 'LOYALTY') {
      if (!modules.includes('loyalty')) throw new AppError('MODULE_DISABLED', 403, 'Module loyalty is not enabled', { module: 'loyalty' });
      if (!customerId) throw new AppError('INVALID_STATE', 409, 'Add the customer to pay with points');
      if (p.amount % settings.loyalty.pointValue !== 0) throw AppError.validation([{ path: 'payments', message: 'Points pay in whole points' }]);
      if (p.amount / settings.loyalty.pointValue < settings.loyalty.minRedeemPoints) {
        throw new AppError('INVALID_STATE', 409, `At least ${settings.loyalty.minRedeemPoints} points must be redeemed at once`);
      }
    }
    if (p.method === 'STORE_CREDIT' && !customerId) throw new AppError('INVALID_STATE', 409, 'Add the customer to pay with store credit');
  }
}

/** Payments must add up to the amount due exactly; cash may be over-tendered and gives change. */
export function settlePayments(payments: { method: PaymentMethodKey; amount: number; tendered?: number; reference?: string; card?: CardResult }[], due: number): SettledPayment[] {
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
    private readonly ledgers: LedgersService,
    private readonly promotions: PromotionsService,
    private readonly modifiers: ModifiersService,
    private readonly batches: BatchesService,
    private readonly prescriptions: PrescriptionsService,
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

  async create(req: RequestWithContext, input: SaleInput, orderPay?: SaleRecord['orderPay']): Promise<SaleWithLines> {
    const tenant = req.tenant!;
    const device = req.device!;
    const cashierId = req.principal!.userId;
    try {
      return await this.createOnce(req, tenant, device, cashierId, input, orderPay ?? null);
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
    orderPay: SaleRecord['orderPay'],
  ): Promise<SaleWithLines> {
    const existing = await this.tenantDb.run(tenant.id, (tx) => this.getSale(tx, input.id));
    if (existing) return existing;

    const [settings, perms, modules] = await Promise.all([
      this.settings.get(tenant.id), this.capabilities.permissionsFor(tenant.id, cashierId), this.capabilities.modulesFor(tenant),
    ]);
    if (input.customerId && !modules.includes('customers')) throw new AppError('MODULE_DISABLED', 403, 'Module customers is not enabled', { module: 'customers' });
    checkTenderRules(input.payments, input.customerId, modules, settings);
    if (input.tip && !modules.includes('tables')) throw new AppError('MODULE_DISABLED', 403, 'Tips need the tables module', { module: 'tables' });
    const wantsModifiers = input.lines.some((l) => l.modifierIds?.length);
    if (wantsModifiers && !modules.includes('modifiers')) throw new AppError('MODULE_DISABLED', 403, 'Module modifiers is not enabled', { module: 'modifiers' });
    const productIds = [...new Set(input.lines.map((l) => l.productId))];
    const { products: rawProducts, promos, customerOk, groups, prices } = await this.tenantDb.run(tenant.id, async (tx) => ({
      prices: await storePrices(tx, device.registerId),
      products: await tx.product.findMany({ where: { id: { in: productIds }, active: true }, include: productInclude }),
      promos: modules.includes('promotions') ? await this.promotions.live(tx) : [],
      customerOk: input.customerId ? !!(await tx.customer.findUnique({ where: { id: input.customerId } })) : true,
      groups: modules.includes('modifiers') ? await this.modifiers.forProducts(tx, productIds) : new Map(),
    }));
    if (!customerOk) throw AppError.notFound('Customer not found');
    // A store's own price replaces the catalog price at its tills.
    const products = rawProducts.map((p) => ({ ...p, price: prices.get(p.id) ?? p.price }));
    const byId = new Map(products.map((p) => [p.id, p]));
    const missing = input.lines.filter((l) => !byId.has(l.productId)).map((l) => l.productId);
    if (missing.length) throw new AppError('NOT_FOUND', 404, 'Product not found or inactive', { productIds: [...new Set(missing)] });
    const family = products.find((p) => p.hasVariants);
    if (family) throw new AppError('INVALID_STATE', 409, `Choose a variant of ${family.name}`, { productId: family.id });

    // Modifiers: the choice must satisfy the product's groups; their deltas make the list price.
    const chosen = input.lines.map((l) => {
      const p = byId.get(l.productId)!;
      const r = chooseModifiers(groups.get(p.id) ?? [], l.modifierIds ?? []);
      if (!r.ok) throw new AppError('INVALID_STATE', 409, `${p.name}: ${r.reason}`, { productId: p.id });
      return r.chosen.map((c) => ({ id: c.id, name: c.name, priceDelta: c.priceDelta }));
    });
    const listPrice = (i: number) => withModifiers(byId.get(input.lines[i].productId)!.price, chosen[i]);

    const { priced } = priceWithPromotions({
      pricesIncludeTax: settings.pricesIncludeTax,
      lines: input.lines.map((l, i) => {
        const p = byId.get(l.productId)!;
        return { key: String(i), productId: p.id, categoryId: p.categoryId, unitPrice: l.unitPrice ?? listPrice(i), qtyMilli: l.qtyMilli, taxes: taxStack(p.taxGroup), discount: l.discount };
      }),
      cartDiscount: input.cartDiscount,
      promotions: promos,
      now: new Date(),
    });

    const approvals: Approval[] = [];
    const saleLines = input.lines.map((l, i) => ({ ...l, listPrice: listPrice(i), unitPrice: l.unitPrice ?? listPrice(i) }));
    for (const n of approvalNeeds(perms, settings, saleLines, input.cartDiscount, priced)) await this.authorize(req, perms, n.action, n.force, approvals);
    // Prescription-only medicines: a prescription item per line, a customer, and a pharmacist (or their approval).
    const rxOn = modules.includes('prescriptions');
    const rxLines = rxOn ? input.lines.filter((l) => byId.get(l.productId)!.rxRequired) : [];
    if (rxLines.length) {
      if (!input.customerId) throw new AppError('INVALID_STATE', 409, 'Prescription medicines need the customer on the sale');
      const missingRx = rxLines.find((l) => !l.prescriptionItemId);
      if (missingRx) throw new AppError('INVALID_STATE', 409, `${byId.get(missingRx.productId)!.name} needs a prescription`, { productId: missingRx.productId });
      await this.authorize(req, perms, 'prescription.dispense', false, approvals);
    }

    const allCash = input.payments.every((p) => p.method === 'CASH');
    const due = allCash ? cashRound(priced.totals.total, settings.cashRoundingUnit) : priced.totals.total;
    if (input.expectedTotal !== due) {
      throw new AppError('TOTAL_MISMATCH', 409, 'The till and the server disagree on the total', { expected: input.expectedTotal, actual: due });
    }
    const payments = settlePayments(input.payments, due + (input.tip ?? 0));

    return this.tenantDb.run(tenant.id, async (tx) => {
      const shift = await this.shifts.requireOpenShift(tx, device.registerId);
      const receiptNo = await this.nextReceiptNo(tx, device.registerId);
      await this.persistSale(tx, tenant.id, {
        id: input.id, storeId: shift.storeId, registerId: device.registerId, shiftId: shift.id, deviceId: device.id, cashierId, receiptNo,
        pricesIncludeTax: settings.pricesIncludeTax, priced, due, payments, cartDiscount: input.cartDiscount, approvals, soldAt: new Date(),
        offline: false, catalogVersion: null, customerId: input.customerId ?? null,
        promotions: appliedPromotions(priced, new Map(promos.map((p) => [p.name, p.id]))),
        loyalty: modules.includes('loyalty') ? settings.loyalty : null,
        tip: input.tip ?? 0,
        orderPay,
        batchesOn: modules.includes('batch-expiry'),
        rxValidDays: rxOn ? settings.pharmacy.rxValidDays : null,
        lines: input.lines.map((l, i) => {
          const p = byId.get(l.productId)!;
          return {
            productId: p.id, name: p.name, sku: p.sku, unitPrice: l.unitPrice ?? listPrice(i), listPrice: listPrice(i), qtyMilli: l.qtyMilli, note: l.note,
            trackStock: p.trackStock, modifiers: chosen[i], orderLineId: orderPay?.lines[i]?.orderLineId ?? null,
            tracksBatches: p.tracksBatches, rxRequired: rxOn && p.rxRequired, prescriptionItemId: l.prescriptionItemId ?? null, unitCost: p.costPrice,
          };
        }),
      }, auditContext(req));
      return (await this.getSale(tx, input.id))!;
    });
  }

  /** Writes a priced, paid sale with its lines, payments, stock movements and audit event. */
  async persistSale(tx: Tx, tenantId: string, r: SaleRecord, ctx: Partial<AuditEntry>) {
    for (const l of r.lines) {
      if (!l.rxRequired || !l.prescriptionItemId) continue;
      const item = await this.prescriptions.checkDispense(tx, l.prescriptionItemId, r.customerId, l.productId, l.qtyMilli, r.rxValidDays ?? 30);
      await this.prescriptions.dispense(tx, item.id, l.qtyMilli, item.dispensedQtyMilli);
    }
    const lineBatches = new Map<number, Awaited<ReturnType<BatchesService['take']>>>();
    if (r.batchesOn) {
      for (const [i, l] of r.lines.entries()) if (l.tracksBatches) lineBatches.set(i, await this.batches.take(tx, r.storeId, l.productId, l.qtyMilli));
    }
    let loyaltyEarned = 0;
    if (r.customerId) {
      // Spend balances under a per-customer lock so two tills cannot spend the same points or credit.
      await this.ledgers.lock(tx, r.customerId);
      const paidWith = (m: PaymentMethodKey) => r.payments.filter((p) => p.method === m).reduce((s, p) => s + p.amount, 0);
      const pointsPaid = paidWith('LOYALTY');
      const creditPaid = paidWith('STORE_CREDIT');
      if (pointsPaid) {
        const points = pointsPaid / (r.loyalty?.pointValue ?? 1);
        const have = await this.ledgers.balance(tx, 'loyalty', r.customerId);
        if (have < points && !r.allowOverdraw) throw new AppError('INVALID_STATE', 409, 'Not enough loyalty points', { balance: have, needed: points });
        await this.ledgers.add(tx, tenantId, 'loyalty', { customerId: r.customerId, delta: -points, reason: 'REDEEM', saleId: r.id, userId: r.cashierId });
      }
      if (creditPaid) {
        const have = await this.ledgers.balance(tx, 'credit', r.customerId);
        if (have < creditPaid && !r.allowOverdraw) throw new AppError('INVALID_STATE', 409, 'Not enough store credit', { balance: have, needed: creditPaid });
        await this.ledgers.add(tx, tenantId, 'credit', { customerId: r.customerId, delta: -creditPaid, reason: 'REDEEM', saleId: r.id, userId: r.cashierId });
      }
      if (r.loyalty) {
        loyaltyEarned = pointsEarned(r.due - pointsPaid - creditPaid, r.loyalty.earnSpend);
        await this.ledgers.add(tx, tenantId, 'loyalty', { customerId: r.customerId, delta: loyaltyEarned, reason: 'EARN', saleId: r.id, userId: r.cashierId });
      }
    }
    await tx.sale.create({
      data: {
        id: r.id, tenantId, storeId: r.storeId, registerId: r.registerId, shiftId: r.shiftId, deviceId: r.deviceId,
        cashierId: r.cashierId, receiptNo: r.receiptNo, pricesIncludeTax: r.pricesIncludeTax,
        subtotal: r.priced.totals.subtotal, discountTotal: r.priced.totals.discountTotal, taxTotal: r.priced.totals.taxTotal, total: r.priced.totals.total,
        rounding: r.due - r.priced.totals.total, due: r.due, change: r.payments.reduce((s, p) => s + p.change, 0),
        taxes: json(r.priced.taxes), cartDiscount: r.cartDiscount ? json(r.cartDiscount) : Prisma.DbNull, approvals: json(r.approvals),
        soldAt: r.soldAt, offline: r.offline, catalogVersion: r.catalogVersion,
        customerId: r.customerId ?? null, loyaltyEarned, promotions: json(r.promotions ?? []), tip: r.tip ?? 0, orderId: r.orderPay?.orderId ?? null,
        lines: {
          create: r.priced.lines.map((l, i) => {
            const src = r.lines[i];
            return {
              ...(src.id ? { id: src.id } : {}),
              position: i, productId: src.productId, name: src.name, sku: src.sku, unitPrice: src.unitPrice, listPrice: src.listPrice,
              qtyMilli: src.qtyMilli, gross: l.gross, discount: l.discount, discounts: json(l.discounts), net: l.net, tax: l.tax,
              taxes: json(l.taxes), total: l.total, note: src.note ?? null, modifiers: json(src.modifiers ?? []), orderLineId: src.orderLineId ?? null,
              batches: json(lineBatches.get(i)?.takes ?? []), prescriptionItemId: src.prescriptionItemId ?? null, unitCost: src.unitCost ?? 0,
            };
          }),
        },
        payments: {
          create: r.payments.map((p) => ({ method: p.method, amount: p.amount, tendered: p.tendered, change: p.change, reference: p.reference ?? null, card: p.card ? json(p.card) : Prisma.DbNull })),
        },
      },
    });
    await this.inventory.apply(
      tx, tenantId,
      r.lines.flatMap((l, i) => {
        if (!l.trackStock) return [];
        const base = { storeId: r.storeId, productId: l.productId, reason: 'SALE' as const, refType: 'Sale', refId: r.id, userId: r.cashierId };
        const lots = lineBatches.get(i);
        if (!lots) return [{ ...base, deltaMilli: -l.qtyMilli }];
        return [...lots.takes.map((t) => ({ ...base, deltaMilli: -t.qtyMilli, batchId: t.batchId })), ...(lots.short ? [{ ...base, deltaMilli: -lots.short }] : [])];
      }),
    );
    if (r.orderPay) await this.markOrderPaid(tx, r.orderPay);
    await this.audit.record(tx, tenantId, {
      ...ctx, action: 'sale.completed', entityType: 'Sale', entityId: r.id,
      after: { receiptNo: r.receiptNo, total: r.priced.totals.total, due: r.due, lines: r.lines.length, approvals: r.approvals, ...(r.offline ? { offline: true } : {}) },
    });
  }

  /**
   * Records what of an order this sale paid for, with an optimistic lock per line, and closes the
   * order once every line that was not voided is paid in full.
   */
  private async markOrderPaid(tx: Tx, pay: NonNullable<SaleRecord['orderPay']>) {
    for (const sel of pay.lines) {
      const line = await tx.orderLine.findUnique({ where: { id: sel.orderLineId } });
      if (!line || line.orderId !== pay.orderId || line.status === 'VOID') throw AppError.notFound('Order line not found');
      if (line.paidQtyMilli + sel.qtyMilli > line.qtyMilli) throw new AppError('INVALID_STATE', 409, 'That is more than is left to pay on the line', { orderLineId: line.id });
      const n = await tx.orderLine.updateMany({ where: { id: line.id, paidQtyMilli: line.paidQtyMilli }, data: { paidQtyMilli: { increment: sel.qtyMilli } } });
      if (n.count !== 1) throw AppError.conflict('The order changed meanwhile; reload it');
    }
    const open = await tx.orderLine.count({ where: { orderId: pay.orderId, status: { not: 'VOID' } } });
    const lines = await tx.orderLine.findMany({ where: { orderId: pay.orderId, status: { not: 'VOID' } }, select: { qtyMilli: true, paidQtyMilli: true } });
    if (open > 0 && lines.every((l) => l.paidQtyMilli >= l.qtyMilli)) {
      await tx.order.update({ where: { id: pay.orderId }, data: { status: 'CLOSED', closedAt: new Date() } });
    }
  }

  /** Voids are only allowed while the sale's shift is still open on this register. */
  async void(req: RequestWithContext, saleId: string, reason: string): Promise<SaleWithLines> {
    const tenant = req.tenant!;
    const device = req.device!;
    const approverId = req.stepUpApprovals?.['sale.void'] ?? null;
    return this.tenantDb.run(tenant.id, async (tx) => {
      const sale = await this.getSale(tx, saleId);
      if (!sale) throw AppError.notFound('Sale not found');
      const shift = await this.shifts.requireOpenShift(tx, device.registerId);
      if (sale.shiftId !== shift.id) throw new AppError('INVALID_STATE', 409, 'Only sales from the current shift on this register can be voided');
      await this.persistVoid(tx, tenant.id, sale, { saleId, userId: req.principal!.userId, reason, approverId, at: new Date() }, auditContext(req));
      return (await this.getSale(tx, saleId))!;
    });
  }

  /** Marks a sale voided and undoes what it did: balances, lots and stock. */
  async persistVoid(tx: Tx, tenantId: string, sale: SaleWithLines, v: VoidRecord, ctx: Partial<AuditEntry>) {
    if (sale.status !== 'COMPLETED') throw new AppError('INVALID_STATE', 409, 'This sale is already voided');
    if (sale.refunds.length) throw new AppError('INVALID_STATE', 409, 'A sale with refunds cannot be voided; refund the rest instead');
    await tx.sale.update({ where: { id: sale.id }, data: { status: 'VOIDED', voidedAt: v.at, voidedById: v.userId, voidReason: v.reason, voidOpId: v.opId ?? null } });
    if (sale.customerId) {
      // Undo everything the sale did to the customer's balances.
      await this.ledgers.lock(tx, sale.customerId);
      for (const kind of ['loyalty', 'credit'] as const) {
        const redeemed = await this.ledgers.sumFor(tx, kind, sale.id, 'REDEEM');
        await this.ledgers.add(tx, tenantId, kind, { customerId: sale.customerId, delta: -redeemed, reason: 'RESTORE', saleId: sale.id, userId: v.userId, note: 'Sale voided' });
      }
      await this.ledgers.add(tx, tenantId, 'loyalty', { customerId: sale.customerId, delta: -sale.loyaltyEarned, reason: 'REVERSE', saleId: sale.id, userId: v.userId, note: 'Sale voided' });
    }
    const tracked = await tx.product.findMany({ where: { id: { in: sale.lines.map((l) => l.productId) }, trackStock: true }, select: { id: true } });
    const trackedIds = new Set(tracked.map((p) => p.id));
    for (const l of sale.lines) {
      const takes = (l.batches as unknown as BatchTake[]) ?? [];
      if (takes.length) await this.batches.giveBack(tx, takes, l.qtyMilli);
    }
    await this.inventory.apply(
      tx, tenantId,
      sale.lines.filter((l) => trackedIds.has(l.productId)).map((l) => ({
        storeId: sale.storeId, productId: l.productId, deltaMilli: l.qtyMilli, reason: 'VOID', refType: 'Sale', refId: sale.id, userId: v.userId,
      })),
    );
    await this.audit.record(tx, tenantId, {
      ...ctx, action: 'sale.voided', entityType: 'Sale', entityId: sale.id,
      before: { status: 'COMPLETED' }, after: { status: 'VOIDED', reason: v.reason, approverId: v.approverId, ...(v.opId ? { offline: true } : {}) },
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

    if (input.method === 'STORE_CREDIT' && !sale.customerId) throw new AppError('INVALID_STATE', 409, 'Only sales with a customer can be refunded to store credit');
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
        offline: false, checkDrawer: true, card: input.method === 'CARD' ? (input.card ?? null) : null,
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
        restock: r.restock, total: r.total, taxTotal: r.taxTotal, rounding: r.paidOut - r.total, offline: r.offline, card: r.card ? json(r.card) : Prisma.DbNull,
        lines: { create: r.lines.map((l) => ({ saleLineId: l.saleLineId, qtyMilli: l.qtyMilli, net: l.net, tax: l.tax, total: l.total })) },
      },
      include: { lines: true },
    });
    const sale = await tx.sale.findUniqueOrThrow({ where: { id: r.saleId }, select: { customerId: true, loyaltyEarned: true, total: true } });
    if (sale.customerId) {
      await this.ledgers.lock(tx, sale.customerId);
      if (r.method === 'STORE_CREDIT') {
        await this.ledgers.add(tx, tenantId, 'credit', { customerId: sale.customerId, delta: r.paidOut, reason: 'REFUND', saleId: r.saleId, refundId: r.id, userId: r.userId });
      }
      if (sale.loyaltyEarned > 0) {
        // Points earned come back in proportion to what has been refunded so far.
        const refunded = (await tx.refund.aggregate({ where: { saleId: r.saleId }, _sum: { total: true } }))._sum.total ?? 0;
        const target = Math.min(sale.loyaltyEarned, prorate(sale.loyaltyEarned, refunded, sale.total));
        const already = -(await this.ledgers.sumFor(tx, 'loyalty', r.saleId, 'REVERSE'));
        await this.ledgers.add(tx, tenantId, 'loyalty', { customerId: sale.customerId, delta: -(target - already), reason: 'REVERSE', saleId: r.saleId, refundId: r.id, userId: r.userId });
      }
    }
    if (r.restock) {
      const saleLines = await tx.saleLine.findMany({ where: { id: { in: r.lines.map((l) => l.saleLineId) } }, select: { id: true, batches: true } });
      for (const l of r.lines) {
        const takes = (saleLines.find((x) => x.id === l.saleLineId)?.batches as unknown as BatchTake[] | undefined) ?? [];
        if (takes.length) await this.batches.giveBack(tx, takes, l.qtyMilli);
      }
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

