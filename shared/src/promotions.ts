import { type Discount, divRound, priceSale, type PricingResult, type TaxRateDef } from './pricing.js';

/**
 * Promotions: the business's own discount rules, applied automatically. Pure, so the till applies
 * them offline exactly as the API does. Output feeds the pricing engine as 'promo' discounts.
 */

export const PROMOTION_KINDS = ['PERCENT_OFF', 'AMOUNT_OFF', 'BUY_X_GET_Y', 'SPEND_THRESHOLD'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

export interface PromotionDef {
  id: string;
  name: string;
  kind: PromotionKind;
  /** Which items qualify. Both empty = everything. */
  productIds: string[];
  categoryIds: string[];
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** PERCENT_OFF and SPEND_THRESHOLD (percent form). */
  percentBp?: number;
  /** AMOUNT_OFF (per unit) and SPEND_THRESHOLD (amount form). */
  amount?: number;
  /** BUY_X_GET_Y: buy this many... */
  buyQty?: number;
  /** ...get this many of the cheapest in each group... */
  getQty?: number;
  /** ...at this discount (default 100% = free). */
  getPercentBp?: number;
  /** SPEND_THRESHOLD: sale amount after item promotions must reach this. */
  minSpend?: number;
}

export interface PromoLine {
  key: string;
  productId: string;
  categoryId: string | null;
  unitPrice: number;
  qtyMilli: number;
}

export interface AppliedLinePromo {
  promotionId: string;
  label: string;
  amount: number;
}

export interface PromoResult {
  /** Per line key: the item promotion applied (at most one per line). */
  lines: Record<string, AppliedLinePromo[]>;
  /** At most one sale-level promotion. */
  cart: { promotionId: string; label: string; discount: Discount }[];
}

const pct = (amount: number, bp: number) => Number(divRound(BigInt(amount) * BigInt(bp), 10_000n));

export function isLive(p: PromotionDef, now: Date): boolean {
  if (!p.active) return false;
  if (p.startsAt && now < new Date(p.startsAt)) return false;
  if (p.endsAt && now >= new Date(p.endsAt)) return false;
  return true;
}

function qualifies(p: PromotionDef, l: PromoLine): boolean {
  if (!p.productIds.length && !p.categoryIds.length) return true;
  return p.productIds.includes(l.productId) || (!!l.categoryId && p.categoryIds.includes(l.categoryId));
}

const gross = (l: PromoLine) => Number(divRound(BigInt(l.unitPrice) * BigInt(l.qtyMilli), 1000n));

export function applyPromotions(lines: readonly PromoLine[], promotions: readonly PromotionDef[], now: Date): PromoResult {
  const live = promotions.filter((p) => isLive(p, now)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const out: PromoResult = { lines: {}, cart: [] };
  const taken = new Set<string>();

  // 1. Buy X get Y: whole units only, grouped by price high to low, the cheapest Y of each X+Y discounted.
  for (const p of live.filter((x) => x.kind === 'BUY_X_GET_Y')) {
    const buy = p.buyQty ?? 0;
    const get = p.getQty ?? 0;
    if (buy < 1 || get < 1) continue;
    const eligible = lines.filter((l) => !taken.has(l.key) && qualifies(p, l) && l.qtyMilli % 1000 === 0);
    const units = eligible.flatMap((l) => Array.from({ length: l.qtyMilli / 1000 }, () => l)).sort((a, b) => b.unitPrice - a.unitPrice);
    const group = buy + get;
    const perLine = new Map<string, number>();
    for (let g = 0; g + group <= units.length; g += group) {
      for (const u of units.slice(g + buy, g + group)) perLine.set(u.key, (perLine.get(u.key) ?? 0) + pct(u.unitPrice, p.getPercentBp ?? 10_000));
    }
    if (!perLine.size) continue;
    for (const l of eligible) taken.add(l.key);
    for (const [key, amount] of perLine) if (amount > 0) out.lines[key] = [{ promotionId: p.id, label: p.name, amount }];
  }

  // 2. Item discounts: each remaining line takes the best one it qualifies for.
  for (const l of lines) {
    if (taken.has(l.key)) continue;
    let best: AppliedLinePromo | null = null;
    for (const p of live) {
      if ((p.kind !== 'PERCENT_OFF' && p.kind !== 'AMOUNT_OFF') || !qualifies(p, l)) continue;
      const g = gross(l);
      const amount = Math.min(g, p.kind === 'PERCENT_OFF' ? pct(g, p.percentBp ?? 0) : Number(divRound(BigInt(p.amount ?? 0) * BigInt(l.qtyMilli), 1000n)));
      if (amount > 0 && (!best || amount > best.amount)) best = { promotionId: p.id, label: p.name, amount };
    }
    if (best) out.lines[l.key] = [best];
  }

  // 3. Spend thresholds on what is left after item promotions: the most generous one that applies.
  const spend = lines.reduce((s, l) => s + gross(l) - (out.lines[l.key]?.reduce((a, x) => a + x.amount, 0) ?? 0), 0);
  let bestCart: { p: PromotionDef; value: number } | null = null;
  for (const p of live.filter((x) => x.kind === 'SPEND_THRESHOLD')) {
    if (spend < (p.minSpend ?? 0)) continue;
    const value = p.percentBp ? pct(spend, p.percentBp) : Math.min(spend, p.amount ?? 0);
    if (value > 0 && (!bestCart || value > bestCart.value)) bestCart = { p, value };
  }
  if (bestCart) {
    const d: Discount = bestCart.p.percentBp ? { kind: 'percent', bp: bestCart.p.percentBp } : { kind: 'amount', amount: bestCart.p.amount ?? 0 };
    out.cart.push({ promotionId: bestCart.p.id, label: bestCart.p.name, discount: d });
  }
  return out;
}

export interface PromoPricingLine extends PromoLine {
  taxes: readonly TaxRateDef[];
  /** A discount typed in by staff. */
  discount?: Discount;
}

/**
 * Promotions, then pricing: item promotions become 'promo' line discounts ahead of any manual line
 * discount; a spend-threshold promotion becomes a 'promo' cart discount ahead of any manual one.
 * `applied` overrides the promotions (offline verification replays what the till applied).
 */
export function priceWithPromotions(input: {
  pricesIncludeTax: boolean;
  lines: readonly PromoPricingLine[];
  cartDiscount?: Discount;
  promotions: readonly PromotionDef[];
  now: Date;
  applied?: PromoResult;
}): { priced: PricingResult; promos: PromoResult } {
  const promos = input.applied ?? applyPromotions(input.lines, input.promotions, input.now);
  const priced = priceSale({
    pricesIncludeTax: input.pricesIncludeTax,
    lines: input.lines.map((l) => ({
      key: l.key,
      unitPrice: l.unitPrice,
      qtyMilli: l.qtyMilli,
      taxes: l.taxes,
      discounts: [
        ...(promos.lines[l.key] ?? []).map((p) => ({ kind: 'amount' as const, amount: p.amount, source: 'promo' as const, label: p.label })),
        ...(l.discount ? [{ ...l.discount, source: 'manual' as const }] : []),
      ],
    })),
    cartDiscounts: [
      ...promos.cart.map((c) => ({ ...c.discount, source: 'promo' as const, label: c.label })),
      ...(input.cartDiscount ? [{ ...input.cartDiscount, source: 'manual' as const }] : []),
    ],
  });
  return { priced, promos };
}
