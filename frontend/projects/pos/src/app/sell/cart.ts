import { computed, Injectable, signal } from '@angular/core';
import { cashRound, type Discount, priceWithPromotions, type PromotionDef, type TenantSettings } from '@pos/shared';
import type { CatalogProduct, ChosenModifier, TillCustomer } from '../api/pos-api';

export interface CartLine {
  key: string;
  product: CatalogProduct;
  qtyMilli: number;
  /** Set only when the price was overridden. */
  unitPrice?: number;
  discount?: Discount;
  note?: string;
  /** Modifiers chosen; their deltas are part of the list price. */
  modifiers?: ChosenModifier[];
}

/** Product price plus chosen modifiers: the price before any override. */
export const listPriceOf = (l: Pick<CartLine, 'product' | 'modifiers'>) => l.product.price + (l.modifiers ?? []).reduce((s, m) => s + m.priceDelta, 0);

let seq = 0;

/**
 * The sale being rung up. Totals come from the same engines the API re-runs (promotions, then
 * pricing), so the till and the server always agree.
 */
@Injectable({ providedIn: 'root' })
export class Cart {
  readonly lines = signal<CartLine[]>([]);
  readonly cartDiscount = signal<Discount | null>(null);
  readonly settings = signal<TenantSettings | null>(null);
  readonly promotions = signal<PromotionDef[]>([]);
  readonly customer = signal<TillCustomer | null>(null);
  /** Re-evaluated when the cart changes, so promotions that start or end mid-sale apply on the next change. */
  private readonly now = computed(() => (this.lines(), new Date()));

  readonly result = computed(() =>
    priceWithPromotions({
      pricesIncludeTax: this.settings()?.pricesIncludeTax ?? true,
      lines: this.lines().map((l) => ({
        key: l.key,
        productId: l.product.id,
        categoryId: l.product.categoryId,
        unitPrice: l.unitPrice ?? listPriceOf(l),
        qtyMilli: l.qtyMilli,
        taxes: l.product.taxes,
        discount: l.discount,
      })),
      cartDiscount: this.cartDiscount() ?? undefined,
      promotions: this.promotions(),
      now: this.now(),
    }),
  );
  readonly priced = computed(() => this.result().priced);
  readonly promos = computed(() => this.result().promos);
  readonly total = computed(() => this.priced().totals.total);
  readonly count = computed(() => this.lines().reduce((s, l) => s + l.qtyMilli, 0) / 1000);
  readonly empty = computed(() => this.lines().length === 0);
  /** Promotion savings by name, for the totals panel and offline receipts. */
  readonly promoTotals = computed(() => {
    const m = new Map<string, number>();
    for (const l of this.priced().lines) for (const p of l.parts) if (p.source === 'promo' && p.label) m.set(p.label, (m.get(p.label) ?? 0) + p.amount);
    return [...m].map(([label, amount]) => ({ label, amount }));
  });

  /** What is due if everything is paid in cash (tenant cash rounding applies). */
  cashDue(): number {
    return cashRound(this.total(), this.settings()?.cashRoundingUnit ?? 1);
  }

  /** Adds one more of a product: bumps the last plain line for it, or starts a new line. */
  add(product: CatalogProduct, qtyMilli = 1000, modifiers: ChosenModifier[] = []) {
    const sameMods = (a?: ChosenModifier[]) => (a ?? []).map((m) => m.id).join() === modifiers.map((m) => m.id).join();
    this.lines.update((lines) => {
      const last = lines[lines.length - 1];
      if (
        last && last.product.id === product.id && sameMods(last.modifiers) && !last.discount && last.unitPrice === undefined && !last.note &&
        qtyMilli % 1000 === 0 && last.qtyMilli % 1000 === 0
      ) {
        return [...lines.slice(0, -1), { ...last, qtyMilli: last.qtyMilli + qtyMilli }];
      }
      return [...lines, { key: `l${++seq}`, product, qtyMilli, ...(modifiers.length ? { modifiers } : {}) }];
    });
  }

  setQty(key: string, qtyMilli: number) {
    if (qtyMilli <= 0) return this.remove(key);
    this.update(key, { qtyMilli });
  }

  update(key: string, patch: Partial<Omit<CartLine, 'key' | 'product'>>) {
    this.lines.update((lines) => lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  remove(key: string) {
    this.lines.update((lines) => lines.filter((l) => l.key !== key));
  }

  clear() {
    this.lines.set([]);
    this.cartDiscount.set(null);
    this.customer.set(null);
  }

  pricedLine(key: string) {
    return this.priced().lines.find((l) => l.key === key);
  }

  promoLabel(key: string) {
    return this.promos().lines[key]?.[0]?.label ?? null;
  }
}
