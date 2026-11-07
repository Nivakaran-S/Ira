import { z } from 'zod';

/** Tenant-wide behaviour. Stored on Tenant.settings; every field has a default so old rows parse. */
export const TenantSettingsSchema = z.object({
  pricesIncludeTax: z.boolean().default(true),
  /** Cash totals round to this many minor units (1 = exact). */
  cashRoundingUnit: z.int().min(1).max(100_000).default(1),
  receipt: z
    .object({
      header: z.string().max(500).default(''),
      footer: z.string().max(500).default('Thank you!'),
      showTaxBreakdown: z.boolean().default(true),
    })
    .prefault({}),
  stepUp: z
    .object({
      /** Refunds above this total (minor units) need a manager PIN. 0 = every refund. */
      refundAbove: z.int().min(0).default(0),
      /** Discounts above this share of the line or sale (basis points) need a manager PIN. */
      discountAboveBp: z.int().min(0).max(10_000).default(1_000),
    })
    .prefault({}),
  offline: z
    .object({
      /** Tills keep selling when the API is unreachable. */
      enabled: z.boolean().default(true),
      /** Hard stop: no offline sales this long after the last successful sync. */
      maxHours: z.int().min(1).max(168).default(24),
      /** Largest refund a till may give offline (minor units). 0 = no offline refunds. */
      maxRefund: z.int().min(0).default(0),
      /** Keyed-in card and other payments offline. Cards charged on an integrated terminal are always accepted. */
      allowCard: z.boolean().default(false),
    })
    .prefault({}),
  scaleBarcode: z
    .object({
      enabled: z.boolean().default(false),
      prefix: z.string().regex(/^\d{1,2}$/).default('2'),
      pluDigits: z.int().min(3).max(6).default(5),
      valueType: z.enum(['weight', 'price']).default('weight'),
    })
    .prefault({}),
  pharmacy: z
    .object({
      /** A prescription can be dispensed for this many days after it was written. */
      rxValidDays: z.int().min(1).max(365).default(30),
      /** Lots expiring within this many days are flagged. */
      expiryWarnDays: z.int().min(1).max(365).default(30),
    })
    .prefault({}),
  loyalty: z
    .object({
      /** One point per this much spent (minor units). */
      earnSpend: z.int().min(1).default(10_000),
      /** What one point is worth when redeemed (minor units). */
      pointValue: z.int().min(1).default(100),
      /** Smallest redemption, in points. */
      minRedeemPoints: z.int().min(1).default(100),
    })
    .prefault({}),
});

export type TenantSettings = z.infer<typeof TenantSettingsSchema>;

/** Old or partial JSON → full settings with defaults filled in. */
export function parseSettings(raw: unknown): TenantSettings {
  const r = TenantSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : TenantSettingsSchema.parse({});
}
