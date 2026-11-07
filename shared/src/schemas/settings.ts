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
      /** Card payments offline (only with a terminal that works offline). */
      allowCard: z.boolean().default(false),
    })
    .prefault({}),
});

export type TenantSettings = z.infer<typeof TenantSettingsSchema>;

/** Old or partial JSON → full settings with defaults filled in. */
export function parseSettings(raw: unknown): TenantSettings {
  const r = TenantSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : TenantSettingsSchema.parse({});
}
