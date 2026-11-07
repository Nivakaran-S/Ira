import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** Stock received into a lot with an expiry date (batch-expiry module). */
export const ReceiveBatchSchema = z.object({
  storeId: z.uuid(),
  productId: z.uuid(),
  lotNo: z.string().trim().min(1).max(40),
  expiresOn: isoDate,
  qtyMilli: z.int().min(1).max(100_000_000),
  note: z.string().trim().max(200).optional(),
});

export const PrescriptionSchema = z.object({
  customerId: z.uuid(),
  prescriber: z.string().trim().min(2).max(120),
  prescriberRegNo: z.string().trim().max(40).optional(),
  issuedOn: isoDate,
  notes: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        qtyMilli: z.int().min(1).max(10_000_000),
        directions: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(30),
});

/** A sale line's lots, first expiring first. Stored on the sale line for recalls. */
export interface BatchTake {
  batchId: string;
  lotNo: string;
  expiresOn: string;
  qtyMilli: number;
}

/**
 * First-expiring-first-out over the lots a store holds. Expired lots are never used. Whatever the
 * lots cannot cover is returned as `short` (the sale still happens; stock goes negative, flagged).
 */
export function allocateFefo(
  lots: readonly { id: string; lotNo: string; expiresOn: string; qtyMilli: number }[],
  want: number,
  today: string,
): { takes: BatchTake[]; short: number } {
  const usable = lots.filter((l) => l.qtyMilli > 0 && l.expiresOn >= today).sort((a, b) => (a.expiresOn < b.expiresOn ? -1 : a.expiresOn > b.expiresOn ? 1 : a.lotNo.localeCompare(b.lotNo)));
  const takes: BatchTake[] = [];
  let left = want;
  for (const l of usable) {
    if (left <= 0) break;
    const q = Math.min(left, l.qtyMilli);
    takes.push({ batchId: l.id, lotNo: l.lotNo, expiresOn: l.expiresOn, qtyMilli: q });
    left -= q;
  }
  return { takes, short: left };
}
