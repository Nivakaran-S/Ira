/** What a till prints. Structured, never raw printer bytes: the hardware bridge renders it. */
export interface ReceiptDoc {
  currency: string;
  header: string[];
  title: string;
  meta: { label: string; value: string }[];
  lines: { name: string; qty: string; unitPrice: string; total: string; note?: string; discount?: string }[];
  totals: { label: string; value: string; bold?: boolean }[];
  taxes: { label: string; value: string }[];
  payments: { label: string; value: string }[];
  footer: string[];
  /** Printed as a CODE128 barcode at the bottom when the printer supports it. */
  barcode?: string;
}
