import { TestBed } from '@angular/core/testing';
import { parseSettings } from '@pos/shared';
import { describe, expect, it } from 'vitest';
import type { CatalogProduct } from '../api/pos-api';
import { Cart } from './cart';

const VAT = { id: 'vat', name: 'VAT', rateBp: 1800, compound: false };
const tea: CatalogProduct = { id: 'p1', name: 'Tea', sku: null, price: 1_000, categoryId: null, trackStock: true, taxes: [VAT] };
const cake: CatalogProduct = { id: 'p2', name: 'Cake', sku: null, price: 2_499, categoryId: null, trackStock: true, taxes: [] };

describe('Cart', () => {
  function cart(settings = {}) {
    const c = TestBed.inject(Cart);
    c.clear();
    c.settings.set(parseSettings(settings));
    return c;
  }

  it('merges repeated taps into one line and prices with the shared engine', () => {
    const c = cart();
    c.add(tea);
    c.add(tea);
    c.add(cake);
    expect(c.lines().map((l) => [l.product.name, l.qtyMilli])).toEqual([
      ['Tea', 2_000],
      ['Cake', 1_000],
    ]);
    expect(c.total()).toBe(4_499);
    expect(c.priced().totals.taxTotal).toBe(305); // 2000 incl. 18% → 1695 + 305
  });

  it('exclusive pricing adds tax on top', () => {
    const c = cart({ pricesIncludeTax: false });
    c.add(tea);
    expect(c.total()).toBe(1_180);
  });

  it('applies line and cart discounts, removes at zero quantity, and rounds cash', () => {
    const c = cart({ cashRoundingUnit: 100 });
    c.add(cake);
    const key = c.lines()[0].key;
    c.update(key, { discount: { kind: 'percent', bp: 1_000 } });
    expect(c.total()).toBe(2_249);
    expect(c.cashDue()).toBe(2_200);
    c.cartDiscount.set({ kind: 'amount', amount: 249 });
    expect(c.total()).toBe(2_000);
    c.setQty(key, 0);
    expect(c.empty()).toBe(true);
  });

  it('does not merge into a discounted line', () => {
    const c = cart();
    c.add(tea);
    c.update(c.lines()[0].key, { discount: { kind: 'amount', amount: 100 } });
    c.add(tea);
    expect(c.lines()).toHaveLength(2);
  });
});
