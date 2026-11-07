import type { Permission } from './permissions.js';
import type { Discount, PricingResult } from './pricing.js';
import type { TenantSettings } from './schemas/settings.js';

/** Exceeds the tenant's step-up threshold: amount / base > thresholdBp / 10000. */
export const overThreshold = (amount: number, base: number, thresholdBp: number) => amount > 0 && amount * 10_000 > thresholdBp * base;

/**
 * Which manager approvals a sale needs. Price overrides always do; discounts do when the cashier
 * lacks discount.apply or exceeds the tenant threshold (force: even holders need a second person).
 * The till applies this offline and the API re-applies it, so both demand the same approvals.
 */
export function approvalNeeds(
  perms: ReadonlySet<string>,
  settings: TenantSettings,
  lines: { unitPrice: number; listPrice: number }[],
  cartDiscount: Discount | undefined,
  priced: PricingResult,
): { action: Permission; force: boolean }[] {
  const needs: { action: Permission; force: boolean }[] = [];
  const threshold = settings.stepUp.discountAboveBp;
  if (lines.some((l) => l.unitPrice !== l.listPrice)) needs.push({ action: 'price.override', force: true });
  // Only discounts staff typed in count; promotions are the business's own rules.
  let anyDiscount = false;
  let over = false;
  let cartManual = 0;
  let cartBase = 0;
  priced.lines.forEach((pl) => {
    const promoLine = pl.parts.filter((p) => p.scope === 'line' && p.source === 'promo').reduce((s, p) => s + p.amount, 0);
    const manualLine = pl.parts.filter((p) => p.scope === 'line' && p.source === 'manual').reduce((s, p) => s + p.amount, 0);
    const allLine = pl.parts.filter((p) => p.scope === 'line').reduce((s, p) => s + p.amount, 0);
    if (pl.parts.some((p) => p.scope === 'line' && p.source === 'manual')) anyDiscount = true;
    if (overThreshold(manualLine, pl.gross - promoLine, threshold)) over = true;
    cartManual += pl.parts.filter((p) => p.scope === 'cart' && p.source === 'manual').reduce((s, p) => s + p.amount, 0);
    cartBase += pl.gross - allLine;
  });
  if (cartDiscount) {
    anyDiscount = true;
    if (overThreshold(cartManual, cartBase, threshold)) over = true;
  }
  if (anyDiscount && (over || !perms.has('discount.apply'))) needs.push({ action: 'discount.apply', force: over });
  return needs;
}
