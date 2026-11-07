import { z } from 'zod';
import { PERMISSIONS } from './permissions.js';
import { DiscountSchema, OFFLINE_PAYMENT_METHODS, PaymentInputSchema } from './schemas/sales.js';

/**
 * Offline operations. A till that cannot reach the API writes these to its outbox; each one is
 * chained to the previous one by hash and signed with the device key, so the server can prove the
 * sequence came from that device, complete and unaltered.
 */

export const GENESIS = '0'.repeat(64);

/** JSON with object keys sorted at every level: the bytes that get hashed are reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const AppliedPromoSchema = z.object({ promotionId: z.uuid(), label: z.string().max(80), amount: z.int().min(0) });
const ApprovalSchema = z.object({ action: z.enum(PERMISSIONS), approverId: z.uuid() });
const TaxDefSchema = z.object({ id: z.string().min(1).max(64), name: z.string().max(40), rateBp: z.int().min(0).max(10_000), compound: z.boolean() });

export const OfflineSaleSchema = z.object({
  id: z.uuid(),
  shiftId: z.uuid(),
  cashierId: z.uuid(),
  receiptNo: z.string().min(1).max(40),
  /** The down-sync cursor the till priced with (decimal string). */
  catalogVersion: z.string().regex(/^\d{1,19}$/),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        qtyMilli: z.int().min(1).max(100_000_000),
        unitPrice: z.int().min(0),
        listPrice: z.int().min(0),
        taxes: z.array(TaxDefSchema).max(5),
        discount: DiscountSchema.optional(),
        note: z.string().max(200).optional(),
        /** The item promotion the till applied, if any. */
        promo: AppliedPromoSchema.optional(),
      }),
    )
    .min(1)
    .max(500),
  cartDiscount: DiscountSchema.optional(),
  /** The spend-threshold promotion the till applied, if any. */
  cartPromo: z.object({ promotionId: z.uuid(), label: z.string().max(80), discount: DiscountSchema }).optional(),
  payments: z.array(PaymentInputSchema.extend({ method: z.enum(OFFLINE_PAYMENT_METHODS) })).min(1).max(10),
  expectedTotal: z.int().min(0),
  approvals: z.array(ApprovalSchema).max(5).default([]),
});

export const OfflineRefundSchema = z.object({
  id: z.uuid(),
  saleId: z.uuid(),
  shiftId: z.uuid(),
  userId: z.uuid(),
  receiptNo: z.string().min(1).max(40),
  lines: z.array(z.object({ saleLineId: z.uuid(), qtyMilli: z.int().min(1) })).min(1).max(500),
  method: z.enum(OFFLINE_PAYMENT_METHODS),
  reason: z.string().trim().min(3).max(200),
  restock: z.boolean(),
  approvals: z.array(ApprovalSchema).max(5).default([]),
});

export const OfflineCashSchema = z.object({
  id: z.uuid(),
  shiftId: z.uuid(),
  userId: z.uuid(),
  type: z.enum(['PAY_IN', 'PAY_OUT', 'NO_SALE']),
  amount: z.int().min(0),
  reason: z.string().trim().min(3).max(200),
  approvals: z.array(ApprovalSchema).max(5).default([]),
});

const chain = {
  seq: z.int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** ECDSA P-256 over the hash string, base64url (IEEE P1363). */
  sig: z.string().min(40).max(200),
};

export const OfflineOpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sale'), payload: OfflineSaleSchema, ...chain }),
  z.object({ kind: z.literal('refund'), payload: OfflineRefundSchema, ...chain }),
  z.object({ kind: z.literal('cash'), payload: OfflineCashSchema, ...chain }),
]);

export type OfflineOp = z.infer<typeof OfflineOpSchema>;
export type OfflineOpKind = OfflineOp['kind'];
export type UnsignedOp = Omit<OfflineOp, 'hash' | 'sig'>;

export const SyncUpSchema = z.object({ ops: z.array(OfflineOpSchema).min(1).max(50) });

export const SyncDownQuerySchema = z.object({
  cursor: z.string().regex(/^\d{1,19}$/).default('0'),
  /** Next unused number in the device's offline receipt block, so the server knows when to issue more. */
  blockNext: z.coerce.number().int().min(0).optional(),
});

/** hash = sha256(prevHash + canonical {seq, kind, createdAt, payload}). */
export function opHash(op: Pick<UnsignedOp, 'prevHash' | 'seq' | 'kind' | 'createdAt' | 'payload'>): Promise<string> {
  return sha256Hex(op.prevHash + canonicalJson({ seq: op.seq, kind: op.kind, createdAt: op.createdAt, payload: op.payload }));
}

export type SyncResult =
  | { id: string; seq: number; status: 'applied' | 'duplicate' }
  | { id: string; seq: number; status: 'quarantined'; reason: string };

/** Offline receipt numbers: the register code, an O, and a number from the device's reserved block. */
export const offlineReceiptNo = (registerCode: string, n: number) => `${registerCode}-O${String(n).padStart(6, '0')}`;
