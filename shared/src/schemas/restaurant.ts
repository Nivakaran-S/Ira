import { z } from 'zod';
import { minorAmount } from './catalog.js';
import { DiscountSchema, PaymentInputSchema } from './sales.js';

const qtyMilli = z.int().min(1).max(100_000_000);

export const ModifierGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    /** 0 = optional. */
    minSelect: z.int().min(0).max(20).default(0),
    maxSelect: z.int().min(1).max(20).default(1),
    options: z
      .array(
        z.object({
          /** Present when editing an existing option. */
          id: z.uuid().optional(),
          name: z.string().trim().min(1).max(60),
          /** Added to the item price; 0 for free choices like "no onion". */
          priceDelta: z.int().min(0).max(10_000_000).default(0),
          active: z.boolean().default(true),
        }),
      )
      .min(1)
      .max(50),
  })
  .refine((g) => g.minSelect <= g.maxSelect, { path: ['minSelect'], message: 'Minimum is above maximum' });

export const SetProductModifiersSchema = z.object({ groupIds: z.array(z.uuid()).max(10) });

export const DiningTableSchema = z.object({
  storeId: z.uuid(),
  name: z.string().trim().min(1).max(30),
  area: z.string().trim().max(40).optional(),
  seats: z.int().min(1).max(50).default(2),
  active: z.boolean().default(true),
});

export const OpenOrderSchema = z.object({
  /** Client-generated, so a retried open is harmless. */
  id: z.uuid(),
  tableId: z.uuid().optional(),
  /** A tab name for counter orders without a table. */
  name: z.string().trim().max(40).optional(),
  guests: z.int().min(1).max(100).optional(),
});

export const OrderLineInputSchema = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  qtyMilli,
  modifierIds: z.array(z.uuid()).max(20).default([]),
  note: z.string().trim().max(200).optional(),
  course: z.int().min(1).max(9).default(1),
});

export const AddOrderLinesSchema = z.object({ lines: z.array(OrderLineInputSchema).min(1).max(100) });

export const KITCHEN_STATUSES = ['PREPARING', 'READY', 'SERVED'] as const;
export const KitchenBumpSchema = z.object({ status: z.enum(KITCHEN_STATUSES) });

export const PayOrderSchema = z.object({
  /** The sale this creates; client-generated, retry-safe. */
  saleId: z.uuid(),
  /** What this payment covers. Paying part of an order (split by items) leaves the rest open. */
  lines: z.array(z.object({ orderLineId: z.uuid(), qtyMilli })).min(1).max(200),
  payments: z.array(PaymentInputSchema).min(1).max(20),
  tip: minorAmount.default(0),
  cartDiscount: DiscountSchema.optional(),
  customerId: z.uuid().optional(),
  expectedTotal: minorAmount,
});

export const MoveOrderSchema = z.object({ tableId: z.uuid() });

export interface ModifierOption {
  id: string;
  name: string;
  priceDelta: number;
  active: boolean;
}
export interface ModifierGroupDef {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: ModifierOption[];
}

/**
 * Checks a choice of modifiers against the product's groups: every option belongs to one of them and
 * is active, and each group's count is within its min and max. Returns the chosen options, or why not.
 */
export function chooseModifiers(
  groups: readonly ModifierGroupDef[],
  modifierIds: readonly string[],
): { ok: true; chosen: (ModifierOption & { groupId: string })[] } | { ok: false; reason: string } {
  const byOption = new Map<string, { group: ModifierGroupDef; option: ModifierOption }>();
  for (const g of groups) for (const o of g.options) byOption.set(o.id, { group: g, option: o });
  const chosen: (ModifierOption & { groupId: string })[] = [];
  const counts = new Map<string, number>();
  for (const id of modifierIds) {
    const hit = byOption.get(id);
    if (!hit || !hit.option.active) return { ok: false, reason: 'Modifier not available for this item' };
    counts.set(hit.group.id, (counts.get(hit.group.id) ?? 0) + 1);
    chosen.push({ ...hit.option, groupId: hit.group.id });
  }
  for (const g of groups) {
    const n = counts.get(g.id) ?? 0;
    if (n < g.minSelect) return { ok: false, reason: `Choose ${g.minSelect === g.maxSelect ? g.minSelect : `at least ${g.minSelect}`} for ${g.name}` };
    if (n > g.maxSelect) return { ok: false, reason: `Choose at most ${g.maxSelect} for ${g.name}` };
  }
  return { ok: true, chosen };
}

/** Item price with its modifiers. */
export const withModifiers = (basePrice: number, chosen: readonly { priceDelta: number }[]) => basePrice + chosen.reduce((s, m) => s + m.priceDelta, 0);
