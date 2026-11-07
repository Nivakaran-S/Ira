/**
 * In-store labels from a weighing scale: EAN-13 = prefix + PLU + value + check digit. The value is
 * the weight in grams or the price in minor units, depending on how the store's scales are set up.
 */

export interface ScaleBarcodeConfig {
  /** Leading digits that mark a scale label, usually '2' or '20'-'29'. */
  prefix: string;
  pluDigits: number;
  valueType: 'weight' | 'price';
}

export function ean13CheckDigit(twelve: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function parseScaleBarcode(code: string, cfg: ScaleBarcodeConfig): { plu: string; value: number; valueType: 'weight' | 'price' } | null {
  if (!/^\d{13}$/.test(code) || !code.startsWith(cfg.prefix)) return null;
  if (ean13CheckDigit(code.slice(0, 12)) !== Number(code[12])) return null;
  const valueDigits = 12 - cfg.prefix.length - cfg.pluDigits;
  if (valueDigits < 3) return null;
  const plu = code.slice(cfg.prefix.length, cfg.prefix.length + cfg.pluDigits);
  const value = Number(code.slice(cfg.prefix.length + cfg.pluDigits, 12));
  return { plu, value, valueType: cfg.valueType };
}
