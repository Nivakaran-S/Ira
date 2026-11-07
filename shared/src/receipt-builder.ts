import { formatMinor, formatQty } from './money.js';
import type { ReceiptDoc } from './receipt.js';

export interface SaleReceiptInput {
  currency: string;
  timezone: string;
  tenantName: string;
  storeName?: string | null;
  header: string;
  footer: string;
  showTaxBreakdown: boolean;
  receiptNo: string;
  soldAt: Date;
  registerCode: string;
  cashierName: string;
  status: 'COMPLETED' | 'VOIDED';
  copy?: boolean;
  /** Shown under the title, e.g. "Offline: will sync". */
  notice?: string;
  pricesIncludeTax: boolean;
  lines: { name: string; qtyMilli: number; unitPrice: number; net: number; discount: number; note?: string | null }[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  rounding: number;
  due: number;
  change: number;
  taxes: { name: string; rateBp: number; amount: number }[];
  payments: { method: string; amount: number; tendered?: number | null }[];
  /** Promotions applied (already included in discountTotal), shown by name. */
  promotions?: { label: string; amount: number }[];
  customerName?: string | null;
  pointsEarned?: number;
  pointsBalance?: number | null;
}

const METHOD_LABEL: Record<string, string> = { CASH: 'Cash', CARD: 'Card', OTHER: 'Other', LOYALTY: 'Points', STORE_CREDIT: 'Store credit' };
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;
const textLines = (text: string) => text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);

export function formatWhen(d: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

/** The one receipt layout, used by the API (online sales, reprints) and the till (offline sales). */
export function buildSaleReceipt(s: SaleReceiptInput): ReceiptDoc {
  const m = (n: number) => formatMinor(n, s.currency);
  const totals: ReceiptDoc['totals'] = [{ label: 'Subtotal', value: m(s.subtotal) }];
  const promos = (s.promotions ?? []).filter((p) => p.amount > 0);
  for (const p of promos) totals.push({ label: p.label, value: `-${m(p.amount)}` });
  const manual = s.discountTotal - promos.reduce((a, p) => a + p.amount, 0);
  if (manual) totals.push({ label: 'Discounts', value: `-${m(manual)}` });
  if (!s.pricesIncludeTax && s.taxTotal) totals.push({ label: 'Tax', value: m(s.taxTotal) });
  if (s.rounding) totals.push({ label: 'Rounding', value: m(s.rounding) });
  totals.push({ label: `TOTAL ${s.currency}`, value: m(s.due), bold: true });
  return {
    currency: s.currency,
    header: [s.tenantName, ...(s.storeName ? [s.storeName] : []), ...textLines(s.header)],
    title: s.status === 'VOIDED' ? 'VOIDED' : s.copy ? 'RECEIPT (COPY)' : 'RECEIPT',
    meta: [
      { label: 'Receipt', value: s.receiptNo },
      { label: 'Date', value: formatWhen(s.soldAt, s.timezone) },
      { label: 'Register', value: s.registerCode },
      { label: 'Cashier', value: s.cashierName },
      ...(s.customerName ? [{ label: 'Customer', value: s.customerName }] : []),
      ...(s.notice ? [{ label: 'Note', value: s.notice }] : []),
    ],
    lines: s.lines.map((l) => ({
      name: l.name,
      qty: formatQty(l.qtyMilli),
      unitPrice: m(l.unitPrice),
      total: m(l.net),
      ...(l.discount ? { discount: `-${m(l.discount)}` } : {}),
      ...(l.note ? { note: l.note } : {}),
    })),
    totals,
    taxes: s.showTaxBreakdown ? s.taxes.map((t) => ({ label: `${t.name} ${pct(t.rateBp)}${s.pricesIncludeTax ? ' (incl.)' : ''}`, value: m(t.amount) })) : [],
    payments: [
      ...s.payments.map((p) => ({ label: METHOD_LABEL[p.method] ?? p.method, value: m(p.tendered ?? p.amount) })),
      ...(s.change ? [{ label: 'Change', value: m(s.change) }] : []),
    ],
    footer: [
      ...(s.pointsEarned ? [`Points earned: ${s.pointsEarned}${s.pointsBalance != null ? ` (balance ${s.pointsBalance})` : ''}`] : []),
      ...textLines(s.footer),
    ],
    barcode: s.receiptNo,
  };
}
