import { z } from 'zod';

const name = z.string().trim().min(1).max(120);
export const minorAmount = z.int().min(0).max(100_000_000_000);

export const TaxRateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  rateBp: z.int().min(0).max(10_000),
  compound: z.boolean().default(false),
  active: z.boolean().default(true),
});

export const TaxGroupSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Order matters: compound rates tax the rates listed before them. */
  rateIds: z.array(z.uuid()).max(5),
});

export const CategorySchema = z.object({
  name,
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  sortOrder: z.int().min(0).max(10_000).default(0),
});

export const ProductSchema = z.object({
  name,
  sku: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).optional(),
  categoryId: z.uuid().nullable().optional(),
  taxGroupId: z.uuid().nullable().optional(),
  price: minorAmount,
  active: z.boolean().default(true),
  trackStock: z.boolean().default(true),
});

export const UpdateProductSchema = ProductSchema.partial();

export const StockAdjustSchema = z.object({
  storeId: z.uuid(),
  productId: z.uuid(),
  /** Signed change in thousandths. */
  deltaMilli: z
    .int()
    .min(-100_000_000)
    .max(100_000_000)
    .refine((n) => n !== 0, 'Change cannot be zero'),
  note: z.string().trim().min(1).max(200),
});
