import { describe, expect, it } from 'vitest';
import { chooseModifiers, type ModifierGroupDef, withModifiers } from './schemas/restaurant.js';

const size: ModifierGroupDef = {
  id: 'size', name: 'Size', minSelect: 1, maxSelect: 1,
  options: [{ id: 's', name: 'Small', priceDelta: 0, active: true }, { id: 'l', name: 'Large', priceDelta: 150, active: true }],
};
const extras: ModifierGroupDef = {
  id: 'extras', name: 'Extras', minSelect: 0, maxSelect: 2,
  options: [
    { id: 'shot', name: 'Extra shot', priceDelta: 100, active: true },
    { id: 'oat', name: 'Oat milk', priceDelta: 80, active: true },
    { id: 'old', name: 'Retired', priceDelta: 50, active: false },
  ],
};

describe('chooseModifiers', () => {
  it('accepts a valid choice and prices it', () => {
    const r = chooseModifiers([size, extras], ['l', 'shot', 'oat']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(withModifiers(500, r.chosen)).toBe(830);
  });

  it('enforces required groups, maximums, membership and active options', () => {
    expect(chooseModifiers([size, extras], ['shot'])).toEqual({ ok: false, reason: 'Choose 1 for Size' });
    expect(chooseModifiers([size], ['s', 'l'])).toEqual({ ok: false, reason: 'Choose at most 1 for Size' });
    expect(chooseModifiers([size], ['s', 'shot']).ok).toBe(false);
    expect(chooseModifiers([size, extras], ['s', 'old']).ok).toBe(false);
  });
});

describe('allocateFefo', async () => {
  const { allocateFefo } = await import('./schemas/grocery.js');
  const lots = [
    { id: 'b', lotNo: 'B', expiresOn: '2026-12-31', qtyMilli: 5_000 },
    { id: 'old', lotNo: 'OLD', expiresOn: '2026-10-01', qtyMilli: 9_000 },
    { id: 'a', lotNo: 'A', expiresOn: '2026-11-30', qtyMilli: 2_000 },
  ];
  it('takes the earliest unexpired lots first and reports any shortfall', () => {
    expect(allocateFefo(lots, 4_000, '2026-11-07')).toEqual({
      takes: [{ batchId: 'a', lotNo: 'A', expiresOn: '2026-11-30', qtyMilli: 2_000 }, { batchId: 'b', lotNo: 'B', expiresOn: '2026-12-31', qtyMilli: 2_000 }],
      short: 0,
    });
    expect(allocateFefo(lots, 10_000, '2026-11-07').short).toBe(3_000);
  });
});
