import { computed, Injectable, signal } from '@angular/core';
import { cashRound, type Discount, priceSale, type TenantSettings } from '@pos/shared';
import type { CatalogProduct } from '../api/pos-api';

export interface CartLine {
  key: string;
  product: CatalogProduct;
  qtyMilli: number;
  /** Set only when the price was overridden. */
  unitPrice?: number;
  discount?: Discount;
  note?: string;
}

let seq = 0;

/** The sale being rung up. Totals come from the same engine the API re-runs, so they always agree. */
@Injectable({ providedIn: 'root' })
export class Cart {
  readonly lines = signal<CartLine[]>([]);
  readonly cartDiscount = signal<Discount | null>(null);
  readonly settings = signal<TenantSettings | null>(null);

  readonly priced = computed(() =>
    priceSale({
      pricesIncludeTax: this.settings()?.pricesIncludeTax ?? true,
      lines: this.lines().map((l) => ({
        key: l.key,
        unitPrice: l.unitPrice ?? l.product.price,
        qtyMilli: l.qtyMilli,
        taxes: l.product.taxes,
        discounts: l.discount ? [l.discount] : [],
      })),
      cartDiscounts: this.cartDiscount() ? [this.cartDiscount()!] : [],
    }),
  );
  readonly total = computed(() => this.priced().totals.total);
  readonly count = computed(() => this.lines().reduce((s, l) => s + l.qtyMilli, 0) / 1000);
  readonly empty = computed(() => this.lines().length === 0);

  /** What is due if everything is paid in cash (tenant cash rounding applies). */
  cashDue(): number {
    return cashRound(this.total(), this.settings()?.cashRoundingUnit ?? 1);
  }

  /** Adds one more of a product: bumps the last plain line for it, or starts a new line. */
  add(product: CatalogProduct, qtyMilli = 1000) {
    this.lines.update((lines) => {
      const last = lines[lines.length - 1];
      if (last && last.product.id === product.id && !last.discount && last.unitPrice === undefined && !last.note && qtyMilli % 1000 === 0 && last.qtyMilli % 1000 === 0) {
        return [...lines.slice(0, -1), { ...last, qtyMilli: last.qtyMilli + qtyMilli }];
      }
      return [...lines, { key: `l${++seq}`, product, qtyMilli }];
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
  }

  /** Line i of the priced result for a cart line. */
  pricedLine(key: string) {
    return this.priced().lines.find((l) => l.key === key);
  }
}
