import { z } from 'zod';
import { PROMOTION_KINDS } from '../promotions.js';
import { minorAmount } from './catalog.js';

/** EAN/UPC/Code128-style codes as scanners type them. */
export const barcode = z.string().trim().min(3).max(48).regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, dot, dash or underscore');

export const SetBarcodesSchema = z.object({ codes: z.array(barcode).max(20) });

export const CreateVariantsSchema = z.object({
  variants: z
    .array(
      z.object({
        variantLabel: z.string().trim().min(1).max(60),
        sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
        /** Defaults to the parent's price. */
        price: minorAmount.optional(),
        barcode: barcode.optional(),
      }),
    )
    .min(1)
    .max(100),
});

export const CustomerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/, 'Phone number')
    .optional(),
  email: z.email().transform((e) => e.toLowerCase()).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export const UpdateCustomerSchema = CustomerSchema.partial();

/** Phone numbers compare by digits only, with a Sri Lankan 0 prefix normalised to +94. */
export function normalizePhone(phone: string, countryCode = '94'): string {
  let d = phone.replace(/[^0-9+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) d = countryCode + d.slice(1);
  return d;
}

export const LedgerAdjustSchema = z.object({
  /** Signed: points for loyalty, minor units for store credit. */
  delta: z.int().min(-10_000_000).max(10_000_000).refine((n) => n !== 0, 'Change cannot be zero'),
  reason: z.string().trim().min(3).max(200),
});

export const PromotionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(PROMOTION_KINDS),
    productIds: z.array(z.uuid()).max(500).default([]),
    categoryIds: z.array(z.uuid()).max(100).default([]),
    active: z.boolean().default(true),
    startsAt: z.iso.datetime({ offset: true }).nullable().default(null),
    endsAt: z.iso.datetime({ offset: true }).nullable().default(null),
    percentBp: z.int().min(1).max(10_000).optional(),
    amount: minorAmount.optional(),
    buyQty: z.int().min(1).max(100).optional(),
    getQty: z.int().min(1).max(100).optional(),
    getPercentBp: z.int().min(1).max(10_000).optional(),
    minSpend: minorAmount.optional(),
  })
  .superRefine((p, ctx) => {
    const need = (field: keyof typeof p, ok: boolean) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [field], message: 'Required for this kind of promotion' });
    };
    if (p.kind === 'PERCENT_OFF') need('percentBp', !!p.percentBp);
    if (p.kind === 'AMOUNT_OFF') need('amount', !!p.amount);
    if (p.kind === 'BUY_X_GET_Y') {
      need('buyQty', !!p.buyQty);
      need('getQty', !!p.getQty);
    }
    if (p.kind === 'SPEND_THRESHOLD') {
      need('minSpend', p.minSpend !== undefined);
      need('percentBp', !!p.percentBp || !!p.amount);
    }
    if (p.startsAt && p.endsAt && p.endsAt <= p.startsAt) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Ends before it starts' });
  });

/** Loyalty points earned and redeemed. */
export function pointsEarned(spend: number, earnSpend: number): number {
  return earnSpend > 0 && spend > 0 ? Math.floor(spend / earnSpend) : 0;
}
