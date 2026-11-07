import { describe, expect, it } from 'vitest';
import { ean13CheckDigit, parseScaleBarcode } from './scale-barcode.js';

const withCheck = (twelve: string) => twelve + ean13CheckDigit(twelve);

describe('scale barcodes', () => {
  it('computes the EAN-13 check digit', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(ean13CheckDigit('479000000001')).toBe(3);
  });

  it('reads weight-embedded labels: prefix, PLU, grams', () => {
    // 2 | 01234 | 001250 | check  →  PLU 01234, 1.250 kg
    expect(parseScaleBarcode(withCheck('201234001250'), { prefix: '2', pluDigits: 5, valueType: 'weight' })).toEqual({ plu: '01234', value: 1250, valueType: 'weight' });
  });

  it('reads price-embedded labels in minor units', () => {
    // 22 | 0005 | 003450 | check  →  PLU 0005, 34.50
    expect(parseScaleBarcode(withCheck('220005003450'), { prefix: '22', pluDigits: 4, valueType: 'price' })).toEqual({ plu: '0005', value: 3450, valueType: 'price' });
  });

  it('ignores ordinary EAN-13 codes, wrong prefixes and bad check digits', () => {
    const cfg = { prefix: '2', pluDigits: 5, valueType: 'weight' as const };
    expect(parseScaleBarcode(withCheck('479123456789'), cfg)).toBeNull();
    const ok = withCheck('201234001250');
    expect(parseScaleBarcode(ok.slice(0, 12) + ((Number(ok[12]) + 1) % 10), cfg)).toBeNull();
    expect(parseScaleBarcode('12345', cfg)).toBeNull();
  });
});
