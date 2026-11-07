/** Minor-unit digits per ISO 4217 currency. Unlisted currencies default to 2. */
const MINOR_DIGITS: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };

export function minorDigits(currency: string): number {
  return MINOR_DIGITS[currency.toUpperCase()] ?? 2;
}

/** 123456 LKR → "1,234.56". No currency symbol: receipts and tills print the code once. */
export function formatMinor(amount: number, currency: string): string {
  const digits = minorDigits(currency);
  const neg = amount < 0;
  const abs = Math.abs(amount);
  const scale = 10 ** digits;
  const whole = Math.floor(abs / scale)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = digits ? '.' + String(abs % scale).padStart(digits, '0') : '';
  return `${neg ? '-' : ''}${whole}${frac}`;
}

/** "1,234.5" → 123450. Returns null for anything that is not a plain non-negative amount. */
export function parseMinor(text: string, currency: string): number | null {
  const digits = minorDigits(currency);
  const t = text.replace(/,/g, '').trim();
  const re = digits ? new RegExp(`^\\d+(?:\\.\\d{0,${digits}})?$`) : /^\d+$/;
  if (!re.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return Number(w) * 10 ** digits + Number(f.padEnd(digits, '0') || 0);
}

/** 1500 → "1.5", 1000 → "1", 250 → "0.25". */
export function formatQty(qtyMilli: number): string {
  const whole = Math.trunc(qtyMilli / 1000);
  const frac = Math.abs(qtyMilli % 1000);
  return frac ? `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}` : String(whole);
}
