import { Injectable } from '@nestjs/common';
import { formatMinor, formatQty, type ReceiptDoc } from '@pos/shared';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { saleInclude } from './sales.service.js';

const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', CARD: 'Card', OTHER: 'Other' };
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;

function when(d: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly settings: SettingsService,
  ) {}

  async forSale(tenant: TenantContext, saleId: string, copy = false): Promise<ReceiptDoc> {
    const profile = await this.settings.profile(tenant.id);
    const { sale, store, register, cashier } = await this.tenantDb.run(tenant.id, async (tx) => {
      const sale = await tx.sale.findUnique({ where: { id: saleId }, include: saleInclude });
      if (!sale) throw AppError.notFound('Sale not found');
      const [store, register, cashier] = await Promise.all([
        tx.store.findUnique({ where: { id: sale.storeId } }),
        tx.register.findUnique({ where: { id: sale.registerId } }),
        tx.user.findUnique({ where: { id: sale.cashierId }, select: { name: true } }),
      ]);
      return { sale, store, register, cashier };
    });
    const c = profile.currency;
    const m = (n: number) => formatMinor(n, c);
    const r = profile.settings.receipt;
    const totals: ReceiptDoc['totals'] = [{ label: 'Subtotal', value: m(sale.subtotal) }];
    if (sale.discountTotal) totals.push({ label: 'Discounts', value: `-${m(sale.discountTotal)}` });
    if (!sale.pricesIncludeTax && sale.taxTotal) totals.push({ label: 'Tax', value: m(sale.taxTotal) });
    if (sale.rounding) totals.push({ label: 'Rounding', value: m(sale.rounding) });
    totals.push({ label: `TOTAL ${c}`, value: m(sale.due), bold: true });
    const taxes = (sale.taxes as { name: string; rateBp: number; amount: number }[]) ?? [];
    return {
      currency: c,
      header: [profile.name, ...(store ? [store.name] : []), ...lines(r.header)],
      title: sale.status === 'VOIDED' ? 'VOIDED' : copy ? 'RECEIPT (COPY)' : 'RECEIPT',
      meta: [
        { label: 'Receipt', value: sale.receiptNo },
        { label: 'Date', value: when(sale.soldAt, profile.timezone) },
        { label: 'Register', value: register?.code ?? '' },
        { label: 'Cashier', value: cashier?.name ?? '' },
      ],
      lines: sale.lines.map((l) => ({
        name: l.name,
        qty: formatQty(l.qtyMilli),
        unitPrice: m(l.unitPrice),
        total: m(l.net),
        ...(l.discount ? { discount: `-${m(l.discount)}` } : {}),
        ...(l.note ? { note: l.note } : {}),
      })),
      totals,
      taxes: r.showTaxBreakdown
        ? taxes.map((t) => ({ label: `${t.name} ${pct(t.rateBp)}${sale.pricesIncludeTax ? ' (incl.)' : ''}`, value: m(t.amount) }))
        : [],
      payments: [
        ...sale.payments.map((p) => ({ label: METHOD_LABEL[p.method] ?? p.method, value: m(p.tendered ?? p.amount) })),
        ...(sale.change ? [{ label: 'Change', value: m(sale.change) }] : []),
      ],
      footer: lines(r.footer),
      barcode: sale.receiptNo,
    };
  }

  async forRefund(tenant: TenantContext, refundId: string): Promise<ReceiptDoc> {
    const profile = await this.settings.profile(tenant.id);
    const data = await this.tenantDb.run(tenant.id, async (tx) => {
      const refund = await tx.refund.findUnique({ where: { id: refundId }, include: { lines: { include: { saleLine: true } }, sale: { select: { receiptNo: true } } } });
      if (!refund) throw AppError.notFound('Refund not found');
      const [store, user] = await Promise.all([
        tx.store.findUnique({ where: { id: refund.storeId } }),
        tx.user.findUnique({ where: { id: refund.userId }, select: { name: true } }),
      ]);
      return { refund, store, user };
    });
    const { refund, store, user } = data;
    const m = (n: number) => formatMinor(n, profile.currency);
    return {
      currency: profile.currency,
      header: [profile.name, ...(store ? [store.name] : [])],
      title: 'REFUND',
      meta: [
        { label: 'Refund', value: refund.receiptNo },
        { label: 'Original', value: refund.sale.receiptNo },
        { label: 'Date', value: when(refund.createdAt, profile.timezone) },
        { label: 'By', value: user?.name ?? '' },
        { label: 'Reason', value: refund.reason },
      ],
      lines: refund.lines.map((l) => ({ name: l.saleLine.name, qty: formatQty(l.qtyMilli), unitPrice: m(l.saleLine.unitPrice), total: `-${m(l.total)}` })),
      totals: [
        ...(refund.rounding ? [{ label: 'Rounding', value: m(-refund.rounding) }] : []),
        { label: `REFUNDED ${profile.currency}`, value: m(refund.total + refund.rounding), bold: true },
      ],
      taxes: refund.taxTotal ? [{ label: 'Tax included', value: m(refund.taxTotal) }] : [],
      payments: [{ label: METHOD_LABEL[refund.method] ?? refund.method, value: m(refund.total + refund.rounding) }],
      footer: lines(profile.settings.receipt.footer),
      barcode: refund.receiptNo,
    };
  }
}
