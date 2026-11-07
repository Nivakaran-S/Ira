import { describe, expect, it } from 'vitest';
import { formatMinor, formatQty, parseMinor } from './money.js';
import { parseSettings } from './schemas/settings.js';

describe('money', () => {
  it('formats minor units with grouping', () => {
    expect(formatMinor(123_456, 'LKR')).toBe('1,234.56');
    expect(formatMinor(5, 'LKR')).toBe('0.05');
    expect(formatMinor(-1_000, 'LKR')).toBe('-10.00');
    expect(formatMinor(1_500, 'JPY')).toBe('1,500');
  });

  it('parses typed amounts strictly', () => {
    expect(parseMinor('1,234.5', 'LKR')).toBe(123_450);
    expect(parseMinor('20', 'LKR')).toBe(2_000);
    expect(parseMinor('0.123', 'LKR')).toBeNull();
    expect(parseMinor('-1', 'LKR')).toBeNull();
    expect(parseMinor('abc', 'LKR')).toBeNull();
  });

  it('formats thousandths quantities', () => {
    expect(formatQty(1_000)).toBe('1');
    expect(formatQty(1_500)).toBe('1.5');
    expect(formatQty(250)).toBe('0.25');
  });
});

describe('tenant settings', () => {
  it('fills defaults for empty or partial JSON', () => {
    expect(parseSettings({})).toMatchObject({ pricesIncludeTax: true, cashRoundingUnit: 1, stepUp: { refundAbove: 0, discountAboveBp: 1_000 } });
    expect(parseSettings({ stepUp: { refundAbove: 500 } }).stepUp).toEqual({ refundAbove: 500, discountAboveBp: 1_000 });
    expect(parseSettings(null).receipt.footer).toBe('Thank you!');
  });
});
