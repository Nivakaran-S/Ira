import { z } from 'zod';
import { minorAmount } from './catalog.js';

const qtyMilli = z.int().min(1).max(100_000_000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const StorePricesSchema = z.object({
  /** Replace this store's prices for these products; null removes the override. */
  prices: z.array(z.object({ productId: z.uuid(), price: minorAmount.nullable() })).min(1).max(500),
});

export const UserStoresSchema = z.object({ storeIds: z.array(z.uuid()).max(100) });

export const SupplierSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.email().optional(),
  notes: z.string().trim().max(500).optional(),
  active: z.boolean().default(true),
});

export const PurchaseOrderSchema = z.object({
  supplierId: z.uuid(),
  storeId: z.uuid(),
  expectedOn: isoDate.optional(),
  note: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ productId: z.uuid(), qtyMilli, unitCost: minorAmount })).min(1).max(500),
});

export const ReceivePurchaseSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.uuid(),
        qtyMilli,
        /** Required for lot-tracked products. */
        lotNo: z.string().trim().min(1).max(40).optional(),
        expiresOn: isoDate.optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const TransferSchema = z.object({
  fromStoreId: z.uuid(),
  toStoreId: z.uuid(),
  note: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ productId: z.uuid(), qtyMilli })).min(1).max(500),
});

export const ReceiveTransferSchema = z.object({
  /** What actually arrived per line; missing lines arrived in full. */
  lines: z.array(z.object({ lineId: z.uuid(), receivedQtyMilli: z.int().min(0).max(100_000_000) })).max(500).default([]),
});

export const BREAKDOWNS = ['store', 'category', 'cashier', 'hour', 'product'] as const;
export const BreakdownQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  by: z.enum(BREAKDOWNS),
  storeId: z.uuid().optional(),
});

export const PlanSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().trim().min(1).max(60),
  maxStores: z.int().min(1).max(10_000),
  maxDevices: z.int().min(1).max(100_000),
  maxUsers: z.int().min(1).max(100_000),
  maxProducts: z.int().min(1).max(10_000_000),
  priceMonthly: minorAmount,
  currency: z.string().length(3).toUpperCase().default('LKR'),
  graceDays: z.int().min(0).max(120).default(15),
});

export const ChangePlanSchema = z.object({ planKey: z.string().min(1) });
export const MarkPaidSchema = z.object({ reference: z.string().trim().min(2).max(80) });

/** CSV with a header row; quotes fields that need it. */
export function toCsv(rows: readonly Record<string, string | number | null | undefined>[], columns: readonly string[]): string {
  const cell = (v: string | number | null | undefined) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
