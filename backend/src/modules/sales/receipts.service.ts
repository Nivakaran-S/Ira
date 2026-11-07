import { Injectable } from '@nestjs/common';
import { buildSaleReceipt, formatMinor, formatQty, formatWhen, type ReceiptDoc } from '@pos/shared';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { saleInclude } from './sales.service.js';

const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', CARD: 'Card', OTHER: 'Other', LOYALTY: 'Points', STORE_CREDIT: 'Store credit' };

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly settings: SettingsService,
  ) {}

  async forSale(tenant: TenantContext, saleId: string, copy = false): Promise<ReceiptDoc> {
    const profile = await this.settings.profile(tenant.id);
    const { sale, store, register, cashier, customer, points } = await this.tenantDb.run(tenant.id, async (tx) => {
      const sale = await tx.sale.findUnique({ where: { id: saleId }, include: saleInclude });
      if (!sale) throw AppError.notFound('Sale not found');
      const [store, register, cashier, customer, points] = await Promise.all([
        tx.store.findUnique({ where: { id: sale.storeId } }),
        tx.register.findUnique({ where: { id: sale.registerId } }),
        tx.user.findUnique({ where: { id: sale.cashierId }, select: { name: true } }),
        sale.customerId ? tx.customer.findUnique({ where: { id: sale.customerId }, select: { name: true } }) : null,
        sale.customerId ? tx.loyaltyLedger.aggregate({ where: { customerId: sale.customerId }, _sum: { delta: true } }) : null,
      ]);
      return { sale, store, register, cashier, customer, points };
    });
    const r = profile.settings.receipt;
    return buildSaleReceipt({
      currency: profile.currency,
      timezone: profile.timezone,
      tenantName: profile.name,
      storeName: store?.name,
      header: r.header,
      footer: r.footer,
      showTaxBreakdown: r.showTaxBreakdown,
      receiptNo: sale.receiptNo,
      soldAt: sale.soldAt,
      registerCode: register?.code ?? '',
      cashierName: cashier?.name ?? '',
      status: sale.status,
      copy,
      pricesIncludeTax: sale.pricesIncludeTax,
      lines: sale.lines.map((l) => {
        const mods = (l.modifiers as { name: string; priceDelta: number }[]) ?? [];
        const modText = mods.map((m) => m.name).join(', ');
        return { ...l, note: [modText, l.note].filter(Boolean).join(' / ') || null };
      }),
      tip: sale.tip,
      subtotal: sale.subtotal,
      discountTotal: sale.discountTotal,
      taxTotal: sale.taxTotal,
      rounding: sale.rounding,
      due: sale.due,
      change: sale.change,
      taxes: (sale.taxes as { name: string; rateBp: number; amount: number }[]) ?? [],
      payments: sale.payments,
      promotions: (sale.promotions as { label: string; amount: number }[]) ?? [],
      customerName: customer?.name ?? null,
      pointsEarned: sale.loyaltyEarned,
      pointsBalance: points ? (points._sum.delta ?? 0) : null,
    });
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
        { label: 'Date', value: formatWhen(refund.createdAt, profile.timezone) },
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
