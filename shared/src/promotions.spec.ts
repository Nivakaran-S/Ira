import { describe, expect, it } from 'vitest';
import { applyPromotions, type PromoLine, type PromotionDef } from './promotions.js';

const NOW = new Date('2026-11-07T10:00:00Z');
const promo = (p: Partial<PromotionDef> & Pick<PromotionDef, 'id' | 'kind'>): PromotionDef => ({
  name: p.id, productIds: [], categoryIds: [], active: true, startsAt: null, endsAt: null, ...p,
});
const line = (key: string, productId: string, unitPrice: number, qtyMilli = 1000, categoryId: string | null = null): PromoLine => ({ key, productId, categoryId, unitPrice, qtyMilli });

describe('applyPromotions', () => {
  it('percent off a category, amount off per unit, best one per line, within dates', () => {
    const r = applyPromotions(
      [line('a', 'tea', 1_000, 2_000, 'drinks'), line('b', 'cake', 2_500, 1_000, 'bakery'), line('c', 'jam', 800)],
      [
        promo({ id: 'p10', kind: 'PERCENT_OFF', percentBp: 1_000, categoryIds: ['drinks'] }),
        promo({ id: 'p15', kind: 'PERCENT_OFF', percentBp: 1_500, categoryIds: ['drinks'], endsAt: '2026-11-01T00:00:00Z' }),
        promo({ id: 'cake300', kind: 'AMOUNT_OFF', amount: 300, productIds: ['cake'] }),
        promo({ id: 'cake5', kind: 'PERCENT_OFF', percentBp: 500, productIds: ['cake'] }),
        promo({ id: 'off', kind: 'PERCENT_OFF', percentBp: 5_000, active: false }),
      ],
      NOW,
    );
    expect(r.lines['a']).toEqual([{ promotionId: 'p10', label: 'p10', amount: 200 }]);
    expect(r.lines['b']).toEqual([{ promotionId: 'cake300', label: 'cake300', amount: 300 }]);
    expect(r.lines['c']).toBeUndefined();
    expect(r.cart).toEqual([]);
  });

  it('buy 2 get 1 free makes the cheapest units in each group free', () => {
    const r = applyPromotions(
      [line('a', 'soap', 300, 3_000), line('b', 'soap-big', 500, 2_000)],
      [promo({ id: 'b2g1', kind: 'BUY_X_GET_Y', buyQty: 2, getQty: 1, productIds: ['soap', 'soap-big'] })],
      NOW,
    );
    // 5 units by price: 500 500 300 | 300 300 → one full group: the 300 in it is free
    expect(r.lines['a']).toEqual([{ promotionId: 'b2g1', label: 'b2g1', amount: 300 }]);
    expect(r.lines['b']).toBeUndefined();
  });

  it('buy 1 get 1 half price, fractional quantities never qualify', () => {
    const r = applyPromotions(
      [line('a', 'shirt', 2_000, 2_000), line('w', 'rice', 400, 1_500)],
      [promo({ id: 'bogo', kind: 'BUY_X_GET_Y', buyQty: 1, getQty: 1, getPercentBp: 5_000 }), promo({ id: 'x', kind: 'PERCENT_OFF', percentBp: 100 })],
      NOW,
    );
    expect(r.lines['a']).toEqual([{ promotionId: 'bogo', label: 'bogo', amount: 1_000 }]);
    // Lines in a buy-X-get-Y group are not discounted again; others still get the best item promo.
    expect(r.lines['w']).toEqual([{ promotionId: 'x', label: 'x', amount: 6 }]);
  });

  it('spend thresholds give a cart discount on what is left after item promos', () => {
    const lines = [line('a', 'tea', 1_000, 5_000, 'drinks')];
    const promos = [
      promo({ id: 'drinks10', kind: 'PERCENT_OFF', percentBp: 1_000, categoryIds: ['drinks'] }),
      promo({ id: 'spend4k', kind: 'SPEND_THRESHOLD', minSpend: 4_000, amount: 250 }),
      promo({ id: 'spend5k', kind: 'SPEND_THRESHOLD', minSpend: 5_000, percentBp: 1_000 }),
    ];
    const r = applyPromotions(lines, promos, NOW);
    // 5000 − 500 = 4500: 5k not reached, 4k gives 250
    expect(r.cart).toEqual([{ promotionId: 'spend4k', label: 'spend4k', discount: { kind: 'amount', amount: 250 } }]);
  });
});
