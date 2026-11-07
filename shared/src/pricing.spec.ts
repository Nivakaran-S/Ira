import { describe, expect, it } from 'vitest';
import { allocate, cashRound, divRound, inclusiveBase, priceSale, prorate, type TaxRateDef } from './pricing.js';

const VAT: TaxRateDef = { id: 'vat', name: 'VAT', rateBp: 1800, compound: false };
const SSCL: TaxRateDef = { id: 'sscl', name: 'SSCL', rateBp: 250, compound: false };
const COMPOUND_VAT: TaxRateDef = { ...VAT, compound: true };

describe('divRound', () => {
  it('rounds half up, away from zero', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(0n, 7n)).toBe(0n);
  });
});

describe('allocate', () => {
  it('splits an amount by weight and never loses a minor unit', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(10, [500, 250, 250])).toEqual([5, 3, 2]);
    expect(allocate(0, [3, 4])).toEqual([0, 0]);
    expect(allocate(7, [0, 0])).toEqual([0, 0]);
  });
});

describe('prorate', () => {
  it('takes a share of a whole, half up', () => {
    expect(prorate(1000, 1, 3)).toBe(333);
    expect(prorate(1000, 2, 3)).toBe(667);
    expect(prorate(1000, 3, 3)).toBe(1000);
  });
});

describe('cashRound', () => {
  it('rounds to the nearest unit, half up', () => {
    expect(cashRound(12_349, 100)).toBe(12_300);
    expect(cashRound(12_350, 100)).toBe(12_400);
    expect(cashRound(12_349, 1)).toBe(12_349);
  });
});

describe('inclusiveBase', () => {
  it('reverses simple and compound stacks', () => {
    expect(inclusiveBase(11_800, [VAT])).toBe(10_000);
    expect(inclusiveBase(12_050, [VAT, SSCL])).toBe(10_000);
    // SSCL first, VAT on (base + SSCL): 10000 * 1.025 * 1.18 = 12095
    expect(inclusiveBase(12_095, [SSCL, COMPOUND_VAT])).toBe(10_000);
  });
});

describe('priceSale', () => {
  it('exclusive: tax per line, half up, quantities in thousandths', () => {
    const r = priceSale({
      pricesIncludeTax: false,
      lines: [
        { key: 'a', unitPrice: 1_000, qtyMilli: 3_000, taxes: [VAT] },
        { key: 'b', unitPrice: 333, qtyMilli: 1_500, taxes: [VAT, SSCL] }, // 499.5 → 500
      ],
    });
    expect(r.lines[0]).toMatchObject({ gross: 3_000, discount: 0, net: 3_000, tax: 540, total: 3_540 });
    expect(r.lines[1]).toMatchObject({ gross: 500, net: 500, tax: 90 + 13, total: 603 });
    expect(r.totals).toEqual({ subtotal: 3_500, discountTotal: 0, taxTotal: 643, total: 4_143 });
    expect(r.taxes).toEqual([
      { id: 'vat', name: 'VAT', rateBp: 1800, taxable: 3_500, amount: 630 },
      { id: 'sscl', name: 'SSCL', rateBp: 250, taxable: 500, amount: 13 },
    ]);
  });

  it('exclusive compound rate taxes the previous taxes too', () => {
    const r = priceSale({ pricesIncludeTax: false, lines: [{ key: 'a', unitPrice: 10_000, qtyMilli: 1_000, taxes: [SSCL, COMPOUND_VAT] }] });
    expect(r.lines[0].taxes).toEqual([
      { id: 'sscl', amount: 250 },
      { id: 'vat', amount: 1_845 },
    ]);
    expect(r.totals.total).toBe(12_095);
  });

  it('inclusive: line total equals the shelf price, tax is carved out', () => {
    const r = priceSale({ pricesIncludeTax: true, lines: [{ key: 'a', unitPrice: 1_000, qtyMilli: 1_000, taxes: [VAT, SSCL] }] });
    // base = 1000 / 1.205 = 829.88 → 830; VAT 149.4→149, SSCL 20.75→21: 830+149+21 = 1000
    expect(r.lines[0]).toMatchObject({ gross: 1_000, net: 1_000, tax: 170, total: 1_000 });
    expect(r.lines[0].taxes).toEqual([
      { id: 'vat', amount: 149 },
      { id: 'sscl', amount: 21 },
    ]);
    expect(r.totals).toEqual({ subtotal: 1_000, discountTotal: 0, taxTotal: 170, total: 1_000 });
  });

  it('inclusive rounding residue lands on the last rate so the sum is exact', () => {
    const r = priceSale({ pricesIncludeTax: true, lines: [{ key: 'a', unitPrice: 999, qtyMilli: 1_000, taxes: [VAT, SSCL] }] });
    const l = r.lines[0];
    expect(l.total).toBe(999);
    expect(l.base + l.taxes.reduce((s, t) => s + t.amount, 0)).toBe(999);
  });

  it('applies line discounts in order, then allocates the cart discount by weight', () => {
    const r = priceSale({
      pricesIncludeTax: false,
      lines: [
        { key: 'a', unitPrice: 1_000, qtyMilli: 2_000, taxes: [], discounts: [{ kind: 'percent', bp: 1_000 }, { kind: 'amount', amount: 100 }] },
        { key: 'b', unitPrice: 1_000, qtyMilli: 1_000, taxes: [] },
      ],
      cartDiscounts: [{ kind: 'amount', amount: 290 }],
    });
    // a: 2000 −200 (10%) −100 = 1700; b: 1000. Cart 290 split 1700:1000 → 183 / 107
    expect(r.lines[0]).toMatchObject({ gross: 2_000, discount: 483, net: 1_517 });
    expect(r.lines[0].discounts).toEqual([200, 100, 183]);
    expect(r.lines[1]).toMatchObject({ discount: 107, net: 893 });
    expect(r.totals).toEqual({ subtotal: 3_000, discountTotal: 590, taxTotal: 0, total: 2_410 });
  });

  it('a discount never takes a line below zero', () => {
    const r = priceSale({ pricesIncludeTax: false, lines: [{ key: 'a', unitPrice: 500, qtyMilli: 1_000, taxes: [VAT], discounts: [{ kind: 'amount', amount: 900 }] }] });
    expect(r.lines[0]).toMatchObject({ discount: 500, net: 0, tax: 0, total: 0 });
  });

  it('cart percent discount', () => {
    const r = priceSale({
      pricesIncludeTax: false,
      lines: [{ key: 'a', unitPrice: 2_000, qtyMilli: 1_000, taxes: [VAT] }],
      cartDiscounts: [{ kind: 'percent', bp: 2_500 }],
    });
    expect(r.lines[0]).toMatchObject({ net: 1_500, tax: 270, total: 1_770 });
  });

  it('rejects non-integer or negative inputs', () => {
    expect(() => priceSale({ pricesIncludeTax: false, lines: [{ key: 'a', unitPrice: 1.5, qtyMilli: 1_000, taxes: [] }] })).toThrow();
    expect(() => priceSale({ pricesIncludeTax: false, lines: [{ key: 'a', unitPrice: 100, qtyMilli: 0, taxes: [] }] })).toThrow();
    expect(() => priceSale({ pricesIncludeTax: false, lines: [{ key: 'a', unitPrice: -1, qtyMilli: 1_000, taxes: [] }] })).toThrow();
  });
});
