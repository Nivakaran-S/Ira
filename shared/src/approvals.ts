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
  lines: { unitPrice: number; listPrice: number; discount?: Discount }[],
  cartDiscount: Discount | undefined,
  priced: PricingResult,
): { action: Permission; force: boolean }[] {
  const needs: { action: Permission; force: boolean }[] = [];
  const threshold = settings.stepUp.discountAboveBp;
  if (lines.some((l) => l.unitPrice !== l.listPrice)) needs.push({ action: 'price.override', force: true });
  let anyDiscount = false;
  let over = false;
  lines.forEach((l, i) => {
    if (!l.discount) return;
    anyDiscount = true;
    const pl = priced.lines[i];
    if (overThreshold(pl.discounts[0] ?? 0, pl.gross, threshold)) over = true;
  });
  if (cartDiscount) {
    anyDiscount = true;
    const cartAmount = priced.lines.reduce((s, l) => s + (l.discounts[l.discounts.length - 1] ?? 0), 0);
    const base = priced.lines.reduce((s, l, i) => s + l.gross - (lines[i].discount ? (l.discounts[0] ?? 0) : 0), 0);
    if (overThreshold(cartAmount, base, threshold)) over = true;
  }
  if (anyDiscount && (over || !perms.has('discount.apply'))) needs.push({ action: 'discount.apply', force: over });
  return needs;
}
