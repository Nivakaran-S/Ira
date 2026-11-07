import { inject, Injectable } from '@angular/core';
import { approvalNeeds, buildSaleReceipt, cashRound, type Permission, type ReceiptDoc, uuidv7 } from '@pos/shared';
import { Approvals } from '../api/approvals';
import { PosSession } from '../device/pos-session';
import type { PaymentDraft } from '../screens/payment-panel';
import { Cart } from '../sell/cart';
import { TillState } from '../till-state';
import { SyncEngine } from './sync-engine';

export class OfflineRefused extends Error {}

export interface OfflineSaleResult {
  id: string;
  receiptNo: string;
  due: number;
  change: number;
  receipt: ReceiptDoc;
}

/**
 * Selling without the API. The cart is priced by the shared engine, approvals are collected with
 * PINs checked on this till, and the sale goes into the signed outbox for the server to verify later.
 */
@Injectable({ providedIn: 'root' })
export class OfflineTill {
  private readonly sync = inject(SyncEngine);
  private readonly state = inject(TillState);
  private readonly session = inject(PosSession);
  private readonly cart = inject(Cart);
  private readonly approvals = inject(Approvals);

  private context() {
    const snap = this.sync.snapshot();
    const allowed = this.sync.offlineAllowed();
    if (!allowed.ok) throw new OfflineRefused(allowed.reason);
    const shift = this.state.shift();
    if (!snap || !shift || shift.shift.status !== 'OPEN') throw new OfflineRefused('No open shift is known on this till. Reconnect to open one.');
    const cashier = this.session.offlineUser() ?? this.state.cashier();
    if (!cashier) throw new OfflineRefused('Sign in again.');
    return { snap, shift, cashier, perms: new Set<string>(this.sync.user(cashier.id)?.permissions ?? []) };
  }

  async sell(payments: PaymentDraft[], id = uuidv7()): Promise<OfflineSaleResult> {
    const { snap, shift, cashier, perms } = this.context();
    const settings = snap.settings;
    if (!settings.offline.allowCard && payments.some((p) => p.method !== 'CASH')) {
      throw new OfflineRefused('Offline, this business takes cash only.');
    }
    const priced = this.cart.priced();
    const lines = this.cart.lines().map((l) => ({
      productId: l.product.id,
      qtyMilli: l.qtyMilli,
      unitPrice: l.unitPrice ?? l.product.price,
      listPrice: l.product.price,
      taxes: l.product.taxes,
      ...(l.discount ? { discount: l.discount } : {}),
      ...(l.note ? { note: l.note } : {}),
    }));
    const cartDiscount = this.cart.cartDiscount() ?? undefined;
    const needs = approvalNeeds(perms, settings, lines, cartDiscount, priced);
    const approvals = await this.approvals.collectOffline(needs.map((n) => n.action));

    const allCash = payments.every((p) => p.method === 'CASH');
    const due = allCash ? cashRound(priced.totals.total, settings.cashRoundingUnit) : priced.totals.total;
    const paid = payments.reduce((s, p) => s + p.amount, 0);
    if (paid !== due) throw new OfflineRefused('Payments do not add up to the amount due.');
    const receiptNo = await this.sync.nextReceiptNo();
    await this.sync.enqueue('sale', {
      id,
      shiftId: shift.shift.id,
      cashierId: cashier.id,
      receiptNo,
      catalogVersion: snap.cursor,
      lines,
      ...(cartDiscount ? { cartDiscount } : {}),
      payments: payments.map((p) => ({ method: p.method, amount: p.amount, ...(p.tendered ? { tendered: p.tendered } : {}), ...(p.reference ? { reference: p.reference } : {}) })),
      expectedTotal: due,
      approvals: approvals as { action: Permission; approverId: string }[],
    });
    const change = payments.reduce((s, p) => s + Math.max(0, (p.tendered ?? p.amount) - p.amount), 0);
    const receipt = buildSaleReceipt({
      currency: snap.currency,
      timezone: snap.timezone,
      tenantName: snap.tenantName,
      storeName: snap.register.store.name,
      header: settings.receipt.header,
      footer: settings.receipt.footer,
      showTaxBreakdown: settings.receipt.showTaxBreakdown,
      receiptNo,
      soldAt: new Date(),
      registerCode: snap.register.code,
      cashierName: cashier.name,
      status: 'COMPLETED',
      notice: 'Offline sale',
      pricesIncludeTax: settings.pricesIncludeTax,
      lines: this.cart.lines().map((l, i) => ({
        name: l.product.name, qtyMilli: l.qtyMilli, unitPrice: l.unitPrice ?? l.product.price, net: priced.lines[i].net, discount: priced.lines[i].discount, note: l.note,
      })),
      subtotal: priced.totals.subtotal,
      discountTotal: priced.totals.discountTotal,
      taxTotal: priced.totals.taxTotal,
      rounding: due - priced.totals.total,
      due,
      change,
      taxes: priced.taxes,
      payments,
    });
    return { id, receiptNo, due, change, receipt };
  }

  async cash(type: 'PAY_IN' | 'PAY_OUT' | 'NO_SALE', amount: number, reason: string) {
    const { shift, cashier, perms } = this.context();
    const needsApproval = type === 'NO_SALE' || !perms.has('drawer.open');
    const approvals = needsApproval ? await this.approvals.collectOffline(['drawer.open']) : [];
    await this.sync.enqueue('cash', {
      id: uuidv7(), shiftId: shift.shift.id, userId: cashier.id, type, amount: type === 'NO_SALE' ? 0 : amount, reason,
      approvals: approvals as { action: Permission; approverId: string }[],
    });
  }
}
