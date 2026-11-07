import { inject, Injectable } from '@angular/core';
import { approvalNeeds, buildSaleReceipt, type CardResult, cashRound, formatMinor, formatQty, type Permission, prorate, type ReceiptDoc, uuidv7 } from '@pos/shared';
import { Approvals } from '../api/approvals';
import type { Sale, ShiftReport } from '../api/pos-api';
import { PosSession } from '../device/pos-session';
import type { PaymentDraft } from '../screens/payment-panel';
import { Cart, listPriceOf } from '../sell/cart';
import { TillState } from '../till-state';
import { addCash, addRefund, addSale, addVoid, closedOffline, openedOffline } from './local-shift';
import { SaleJournal } from './sale-journal';
import { SyncEngine } from './sync-engine';

export class OfflineRefused extends Error {}

export interface OfflineSaleResult {
  id: string;
  receiptNo: string;
  due: number;
  change: number;
  receipt: ReceiptDoc;
}

type Approved = { action: Permission; approverId: string }[];
const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', CARD: 'Card', OTHER: 'Other', STORE_CREDIT: 'Store credit' };

/**
 * The till without the API. The cart is priced by the shared engine, approvals are collected with
 * PINs checked on this till, and every action goes into the signed outbox for the server to verify
 * later. The sales journal and the local shift report are updated as each action is recorded.
 */
@Injectable({ providedIn: 'root' })
export class OfflineTill {
  private readonly sync = inject(SyncEngine);
  private readonly state = inject(TillState);
  private readonly session = inject(PosSession);
  private readonly cart = inject(Cart);
  private readonly approvals = inject(Approvals);
  private readonly journal = inject(SaleJournal);

  private base() {
    const snap = this.sync.snapshot();
    const allowed = this.sync.offlineAllowed();
    if (!allowed.ok) throw new OfflineRefused(allowed.reason);
    const cashier = this.session.offlineUser() ?? this.state.cashier() ?? this.session.person();
    if (!snap || !cashier) throw new OfflineRefused('Sign in again.');
    return { snap, cashier, perms: new Set<string>(this.sync.user(cashier.id)?.permissions ?? []) };
  }

  private context() {
    const b = this.base();
    const shift = this.state.shift();
    if (!shift || shift.shift.status !== 'OPEN') throw new OfflineRefused('No shift is open on this till. Open one first.');
    return { ...b, shift };
  }

  private async setShift(r: ShiftReport | null) {
    await this.state.setShift(r);
  }

  async sell(payments: PaymentDraft[], id = uuidv7(), tip = 0): Promise<OfflineSaleResult> {
    const { snap, shift, cashier, perms } = this.context();
    const settings = snap.settings;
    const customer = this.cart.customer() ? this.sync.customer(this.cart.customer()!.id) ?? this.cart.customer() : null;
    const paid = (m: string) => payments.filter((p) => p.method === m).reduce((s, p) => s + p.amount, 0);
    if ((paid('LOYALTY') || paid('STORE_CREDIT')) && !customer) throw new OfflineRefused('Add the customer to pay with points or store credit.');
    const points = paid('LOYALTY') / settings.loyalty.pointValue;
    if (customer && points > customer.points) throw new OfflineRefused('Not enough points.');
    if (customer && paid('STORE_CREDIT') > customer.credit) throw new OfflineRefused('Not enough store credit.');
    if (this.cart.lines().some((l) => l.product.rxRequired)) throw new OfflineRefused('Prescription medicines can only be sold online.');
    // Cards charged on the terminal are settled facts; keyed-in cards and other methods need the setting.
    if (!settings.offline.allowCard && payments.some((p) => (p.method === 'CARD' && !p.card) || p.method === 'OTHER')) {
      throw new OfflineRefused('Offline, this business takes cash, terminal cards, points and store credit only.');
    }
    const priced = this.cart.priced();
    const promos = this.cart.promos();
    const lines = this.cart.lines().map((l) => ({
      id: uuidv7(),
      productId: l.product.id,
      qtyMilli: l.qtyMilli,
      unitPrice: l.unitPrice ?? listPriceOf(l),
      listPrice: listPriceOf(l),
      ...(l.modifiers?.length ? { modifiers: l.modifiers } : {}),
      taxes: l.product.taxes,
      ...(l.discount ? { discount: l.discount } : {}),
      ...(l.note ? { note: l.note } : {}),
      ...(promos.lines[l.key]?.[0] ? { promo: promos.lines[l.key][0] } : {}),
    }));
    const cartDiscount = this.cart.cartDiscount() ?? undefined;
    const needs = approvalNeeds(perms, settings, lines, cartDiscount, priced);
    const approvals = await this.approvals.collectOffline(needs.map((n) => n.action));

    const allCash = payments.every((p) => p.method === 'CASH');
    const due = allCash ? cashRound(priced.totals.total, settings.cashRoundingUnit) : priced.totals.total;
    if (payments.reduce((s, p) => s + p.amount, 0) !== due + tip) throw new OfflineRefused('Payments do not add up to the amount due.');
    const receiptNo = await this.sync.nextReceiptNo();
    const clean = payments.map((p) => ({
      method: p.method, amount: p.amount, ...(p.tendered ? { tendered: p.tendered } : {}), ...(p.reference ? { reference: p.reference } : {}), ...(p.card ? { card: p.card } : {}),
    }));
    await this.sync.enqueue('sale', {
      id,
      shiftId: shift.shift.id,
      cashierId: cashier.id,
      receiptNo,
      ...(customer ? { customerId: customer.id } : {}),
      catalogVersion: snap.cursor,
      lines,
      ...(cartDiscount ? { cartDiscount } : {}),
      ...(promos.cart[0] ? { cartPromo: promos.cart[0] } : {}),
      payments: clean,
      expectedTotal: due,
      tip,
      approvals: approvals as Approved,
    });
    if (customer) await this.sync.spend(customer.id, points, paid('STORE_CREDIT'));
    const change = payments.reduce((s, p) => s + Math.max(0, (p.tendered ?? p.amount) - p.amount), 0);
    const soldAt = new Date();
    const record: Sale = {
      id, receiptNo, status: 'COMPLETED', subtotal: priced.totals.subtotal, discountTotal: priced.totals.discountTotal, taxTotal: priced.totals.taxTotal,
      total: priced.totals.total, rounding: due - priced.totals.total, due, change, soldAt: soldAt.toISOString(), shiftId: shift.shift.id,
      customerId: customer?.id ?? null, loyaltyEarned: 0, tip, refunds: [], offline: true,
      lines: this.cart.lines().map((l, i) => ({
        id: lines[i].id, position: i, productId: l.product.id, name: l.product.name, unitPrice: lines[i].unitPrice, listPrice: lines[i].listPrice,
        qtyMilli: l.qtyMilli, gross: priced.lines[i].gross, discount: priced.lines[i].discount, net: priced.lines[i].net, tax: priced.lines[i].tax,
        total: priced.lines[i].total, refundedQtyMilli: 0,
      })),
      payments: clean.map((p, i) => ({ id: `${id}-${i}`, method: p.method, amount: p.amount, tendered: p.method === 'CASH' ? (p.tendered ?? p.amount) : null, change: 0, reference: p.reference ?? null, card: p.card ?? null })),
    };
    await this.journal.put(record);
    await this.setShift(addSale(shift, record));
    const receipt = buildSaleReceipt({
      currency: snap.currency,
      timezone: snap.timezone,
      tenantName: snap.tenantName,
      storeName: snap.register.store.name,
      header: settings.receipt.header,
      footer: settings.receipt.footer,
      showTaxBreakdown: settings.receipt.showTaxBreakdown,
      receiptNo,
      soldAt,
      registerCode: snap.register.code,
      cashierName: cashier.name,
      status: 'COMPLETED',
      notice: 'Offline sale',
      pricesIncludeTax: settings.pricesIncludeTax,
      lines: this.cart.lines().map((l, i) => ({
        name: l.product.name, qtyMilli: l.qtyMilli, unitPrice: l.unitPrice ?? listPriceOf(l), net: priced.lines[i].net, discount: priced.lines[i].discount,
        note: [(l.modifiers ?? []).map((m) => m.name).join(', '), l.note].filter(Boolean).join(' / ') || undefined,
      })),
      subtotal: priced.totals.subtotal,
      discountTotal: priced.totals.discountTotal,
      taxTotal: priced.totals.taxTotal,
      rounding: due - priced.totals.total,
      due,
      change,
      taxes: priced.taxes,
      payments,
      promotions: this.cart.promoTotals(),
      customerName: customer?.name ?? null,
      tip,
    });
    return { id, receiptNo, due, change, receipt };
  }

  /** Refund amounts per line, split exactly as the server splits them. */
  static amounts(sale: Sale, lines: { saleLineId: string; qtyMilli: number }[]) {
    return lines.map((r) => {
      const l = sale.lines.find((x) => x.id === r.saleLineId)!;
      const share = (whole: number) => prorate(whole, l.refundedQtyMilli + r.qtyMilli, l.qtyMilli) - prorate(whole, l.refundedQtyMilli, l.qtyMilli);
      return { ...r, name: l.name, total: share(l.total) };
    });
  }

  /** Whether the signed-in person needs a manager to refund this much (same rule as the server). */
  refundNeedsApproval(total: number): boolean {
    const cashier = this.session.offlineUser() ?? this.state.cashier() ?? this.session.person();
    const perms = new Set<string>((cashier && this.sync.user(cashier.id)?.permissions) || []);
    return !perms.has('sale.refund') || total > (this.sync.snapshot()?.settings.stepUp.refundAbove ?? 0);
  }

  async refund(
    sale: Sale, lines: { saleLineId: string; qtyMilli: number }[], method: 'CASH' | 'CARD' | 'OTHER' | 'STORE_CREDIT', reason: string, restock: boolean,
    id = uuidv7(), card?: CardResult, collected?: { action: string; approverId: string }[],
  ): Promise<{ receiptNo: string; paidOut: number; receipt: ReceiptDoc }> {
    const { snap, shift, cashier, perms } = this.context();
    const settings = snap.settings;
    if (sale.status !== 'COMPLETED') throw new OfflineRefused('Voided sales cannot be refunded.');
    if (method === 'STORE_CREDIT' && !sale.customerId) throw new OfflineRefused('Only sales with a customer can be refunded to store credit.');
    const parts = OfflineTill.amounts(sale, lines);
    const total = parts.reduce((s, p) => s + p.total, 0);
    if (total > settings.offline.maxRefund) {
      throw new OfflineRefused(settings.offline.maxRefund ? `Offline refunds are limited to ${formatMinor(settings.offline.maxRefund, snap.currency)}.` : 'This business does not allow refunds offline.');
    }
    const paidOut = method === 'CASH' ? cashRound(total, settings.cashRoundingUnit) : total;
    if (method === 'CASH' && paidOut > shift.cash.expected) throw new OfflineRefused('The drawer does not hold enough cash for this refund.');
    const needsApproval = !perms.has('sale.refund') || total > settings.stepUp.refundAbove;
    const approvals = collected ?? (needsApproval ? await this.approvals.collectOffline(['sale.refund']) : []);
    const receiptNo = await this.sync.nextReceiptNo();
    await this.sync.enqueue('refund', {
      id, saleId: sale.id, shiftId: shift.shift.id, userId: cashier.id, receiptNo, lines, method, reason, restock,
      ...(card ? { card } : {}), approvals: approvals as Approved,
    });
    await this.journal.update(sale.receiptNo, (s) => ({
      ...s,
      lines: s.lines.map((l) => ({ ...l, refundedQtyMilli: l.refundedQtyMilli + (lines.find((r) => r.saleLineId === l.id)?.qtyMilli ?? 0) })),
      refunds: [...s.refunds, { id, receiptNo, total, rounding: paidOut - total, method, createdAt: new Date().toISOString() }],
    }));
    await this.setShift(addRefund(shift, method, paidOut));
    const m = (n: number) => formatMinor(n, snap.currency);
    const receipt: ReceiptDoc = {
      currency: snap.currency,
      header: [snap.tenantName, snap.register.store.name],
      title: 'REFUND',
      meta: [
        { label: 'Refund', value: receiptNo },
        { label: 'Sale', value: sale.receiptNo },
        { label: 'Date', value: new Date().toLocaleString() },
        { label: 'Cashier', value: cashier.name },
        { label: 'Note', value: 'Offline refund' },
      ],
      lines: parts.map((p) => ({ name: p.name, qty: formatQty(p.qtyMilli), unitPrice: '', total: `-${m(p.total)}` })),
      totals: [...(paidOut !== total ? [{ label: 'Rounding', value: m(paidOut - total) }] : []), { label: `REFUND ${snap.currency}`, value: m(paidOut), bold: true }],
      taxes: [],
      payments: [
        { label: `${METHOD_LABEL[method] ?? method}${card ? ` ${card.scheme} ****${card.last4}` : ''}`, value: m(paidOut) },
        ...(card ? [{ label: '  Approval', value: card.authCode }] : []),
      ],
      footer: [reason],
      barcode: receiptNo,
    };
    return { receiptNo, paidOut, receipt };
  }

  /** Voids a sale of the open shift. Always needs a manager's approval, as online. */
  async voidSale(sale: Sale, reason: string): Promise<void> {
    const { shift, cashier } = this.context();
    if (sale.status !== 'COMPLETED') throw new OfflineRefused('This sale is already voided.');
    if (sale.refunds.length) throw new OfflineRefused('A sale with refunds cannot be voided; refund the rest instead.');
    if (sale.shiftId !== shift.shift.id) throw new OfflineRefused('Only sales from the current shift can be voided.');
    const approvals = await this.approvals.collectOffline(['sale.void']);
    await this.sync.enqueue('void', { id: uuidv7(), saleId: sale.id, userId: cashier.id, reason, approvals: approvals as Approved });
    await this.journal.update(sale.receiptNo, (s) => ({ ...s, status: 'VOIDED' }));
    if (sale.customerId && sale.offline) {
      const paid = (m: string) => sale.payments.filter((p) => p.method === m).reduce((s, p) => s + p.amount, 0);
      await this.sync.spend(sale.customerId, -paid('LOYALTY') / (this.sync.snapshot()?.settings.loyalty.pointValue ?? 1), -paid('STORE_CREDIT'));
    }
    await this.setShift(addVoid(shift, sale));
  }

  async openShift(openingFloat: number): Promise<ShiftReport> {
    const { snap, cashier } = this.base();
    const open = this.state.shift();
    if (open && open.shift.status === 'OPEN') throw new OfflineRefused('A shift is already open on this till.');
    const id = uuidv7();
    await this.sync.enqueue('shift_open', { id, userId: cashier.id, openingFloat });
    const report = openedOffline(id, snap.register.id, openingFloat, new Date());
    await this.setShift(report);
    return report;
  }

  /** Closes the shift against the till's own sums; the server recomputes its Z report when the op arrives. */
  async closeShift(countedCash: number, note?: string): Promise<ShiftReport> {
    const { shift, cashier, perms } = this.context();
    const approvals = perms.has('shift.close') ? [] : await this.approvals.collectOffline(['shift.close']);
    await this.sync.enqueue('shift_close', {
      id: uuidv7(), shiftId: shift.shift.id, userId: cashier.id, countedCash, ...(note ? { note } : {}), approvals: approvals as Approved,
    });
    const z = closedOffline(shift, countedCash, note, new Date());
    await this.setShift(null);
    return z;
  }

  async cash(type: 'PAY_IN' | 'PAY_OUT' | 'NO_SALE', amount: number, reason: string) {
    const { shift, cashier, perms } = this.context();
    if (type === 'PAY_OUT' && amount > shift.cash.expected) throw new OfflineRefused('The drawer does not hold that much cash.');
    const needsApproval = type === 'NO_SALE' || !perms.has('drawer.open');
    const approvals = needsApproval ? await this.approvals.collectOffline(['drawer.open']) : [];
    const value = type === 'NO_SALE' ? 0 : amount;
    await this.sync.enqueue('cash', {
      id: uuidv7(), shiftId: shift.shift.id, userId: cashier.id, type, amount: value, reason,
      approvals: approvals as Approved,
    });
    await this.setShift(addCash(shift, type, value, reason, new Date()));
  }
}
