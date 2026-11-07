/**
 * The pricing and tax engine. Pure and integer-only: every amount is in minor units (cents),
 * quantities are in thousandths (1 item = 1000, 0.250 kg = 250). The till runs it offline and the
 * API re-runs it on every sale; both must agree to the minor unit.
 */

export interface TaxRateDef {
  id: string;
  name: string;
  /** Basis points: 1800 = 18%. */
  rateBp: number;
  /** Compound rates tax the base plus every earlier rate in the stack. */
  compound: boolean;
}

export type Discount = { kind: 'percent'; bp: number } | { kind: 'amount'; amount: number };

/** Where a discount came from. Promotions are applied by the system; manual ones by staff (and may need approval). */
export type DiscountSource = 'manual' | 'promo';
export type SourcedDiscount = Discount & { source?: DiscountSource; label?: string };

export interface DiscountPart {
  amount: number;
  source: DiscountSource;
  scope: 'line' | 'cart';
  label?: string;
}

export interface PricingLineInput {
  key: string;
  unitPrice: number;
  qtyMilli: number;
  /** Ordered: compound rates see the rates before them. */
  taxes: readonly TaxRateDef[];
  /** Applied in order, each on what is left. */
  discounts?: readonly SourcedDiscount[];
}

export interface PricingInput {
  pricesIncludeTax: boolean;
  lines: readonly PricingLineInput[];
  /** Applied to the sale after line discounts, spread over lines by their remaining amount. */
  cartDiscounts?: readonly SourcedDiscount[];
}

export interface PricedLine {
  key: string;
  /** unitPrice × qty, rounded. */
  gross: number;
  /** Every discount on this line, in order: line discounts, then its share of each cart discount. */
  discounts: number[];
  /** The same amounts with where each came from. */
  parts: DiscountPart[];
  discount: number;
  /** What the customer pays for the line before exclusive tax (gross − discount). */
  net: number;
  /** The taxable base: net for exclusive pricing, net with tax carved out for inclusive. */
  base: number;
  taxes: { id: string; amount: number }[];
  tax: number;
  total: number;
}

export interface TaxSummary {
  id: string;
  name: string;
  rateBp: number;
  taxable: number;
  amount: number;
}

export interface PricingResult {
  lines: PricedLine[];
  taxes: TaxSummary[];
  totals: { subtotal: number; discountTotal: number; taxTotal: number; total: number };
}

const BP = 10_000n;

function assertInt(n: number, what: string, min = 0) {
  if (!Number.isSafeInteger(n) || n < min) throw new RangeError(`${what} must be an integer ≥ ${min}, got ${n}`);
}

/** n / d rounded half away from zero. d > 0. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('divisor must be positive');
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a * 2n + d) / (2n * d);
  return neg ? -q : q;
}

/** Share of `amount` for part/whole, half up. */
export function prorate(amount: number, part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Number(divRound(BigInt(amount) * BigInt(part), BigInt(whole)));
}

/** Splits a non-negative amount across weights (largest remainder; ties go to the earlier weight). */
export function allocate(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const A = BigInt(amount);
  const T = BigInt(total);
  const shares = weights.map((w) => (A * BigInt(w)) / T);
  const rems = weights.map((w, i) => ({ i, r: (A * BigInt(w)) % T }));
  let left = Number(A - shares.reduce((s, x) => s + x, 0n));
  rems.sort((x, y) => (y.r > x.r ? 1 : y.r < x.r ? -1 : x.i - y.i));
  for (const { i } of rems) {
    if (left <= 0) break;
    shares[i] += 1n;
    left--;
  }
  return shares.map(Number);
}

/** Rounds a cash amount to the nearest `unit` minor units (half up). unit 1 = no rounding. */
export function cashRound(amount: number, unit: number): number {
  if (unit <= 1) return amount;
  return Number(divRound(BigInt(amount), BigInt(unit)) * BigInt(unit));
}

/**
 * The stack as a rational multiplier: tax(base) = base × num / den. Exact, so inclusive prices can be
 * reversed without floating point.
 */
function stackFactor(taxes: readonly TaxRateDef[]): { num: bigint; den: bigint } {
  // T = total tax per unit of base, as num/den with den = BP^k.
  let num = 0n;
  let den = 1n;
  for (const t of taxes) {
    const r = BigInt(t.rateBp);
    // this rate's tax per unit base: r/BP × (compound ? 1 + T : 1)
    const tNum = t.compound ? r * (den + num) : r * den;
    const tDen = BP * den;
    num = num * BP + tNum;
    den = tDen;
  }
  return { num, den };
}

/** The pre-tax base whose taxes bring it to `total`. */
export function inclusiveBase(total: number, taxes: readonly TaxRateDef[]): number {
  const { num, den } = stackFactor(taxes);
  return Number(divRound(BigInt(total) * den, den + num));
}

function exclusiveTaxes(base: number, taxes: readonly TaxRateDef[]): { id: string; amount: number }[] {
  const out: { id: string; amount: number }[] = [];
  let prev = 0;
  for (const t of taxes) {
    const taxable = t.compound ? base + prev : base;
    const amount = Number(divRound(BigInt(taxable) * BigInt(t.rateBp), BP));
    out.push({ id: t.id, amount });
    prev += amount;
  }
  return out;
}

function discountAmount(d: Discount, on: number): number {
  if (d.kind === 'percent') {
    assertInt(d.bp, 'discount bp');
    return Math.min(on, Number(divRound(BigInt(on) * BigInt(Math.min(d.bp, 10_000)), BP)));
  }
  assertInt(d.amount, 'discount amount');
  return Math.min(on, d.amount);
}

export function priceSale(input: PricingInput): PricingResult {
  const work = input.lines.map((l) => {
    assertInt(l.unitPrice, 'unitPrice');
    assertInt(l.qtyMilli, 'qtyMilli', 1);
    for (const t of l.taxes) assertInt(t.rateBp, 'rateBp');
    const gross = Number(divRound(BigInt(l.unitPrice) * BigInt(l.qtyMilli), 1000n));
    const discounts: number[] = [];
    const parts: DiscountPart[] = [];
    let left = gross;
    for (const d of l.discounts ?? []) {
      const a = discountAmount(d, left);
      discounts.push(a);
      parts.push({ amount: a, source: d.source ?? 'manual', scope: 'line', ...(d.label ? { label: d.label } : {}) });
      left -= a;
    }
    return { line: l, gross, discounts, parts, left };
  });

  for (const d of input.cartDiscounts ?? []) {
    const pool = work.reduce((s, w) => s + w.left, 0);
    const amount = discountAmount(d, pool);
    const shares = allocate(amount, work.map((w) => w.left));
    work.forEach((w, i) => {
      w.discounts.push(shares[i]);
      w.parts.push({ amount: shares[i], source: d.source ?? 'manual', scope: 'cart', ...(d.label ? { label: d.label } : {}) });
      w.left -= shares[i];
    });
  }

  const lines: PricedLine[] = work.map(({ line, gross, discounts, parts, left: net }) => {
    let base: number;
    let taxes: { id: string; amount: number }[];
    if (input.pricesIncludeTax) {
      base = inclusiveBase(net, line.taxes);
      taxes = exclusiveTaxes(base, line.taxes);
      const residue = net - base - taxes.reduce((s, t) => s + t.amount, 0);
      if (taxes.length) taxes[taxes.length - 1].amount += residue;
      else base = net;
    } else {
      base = net;
      taxes = exclusiveTaxes(base, line.taxes);
    }
    const tax = taxes.reduce((s, t) => s + t.amount, 0);
    const discount = discounts.reduce((s, x) => s + x, 0);
    return { key: line.key, gross, discounts, parts, discount, net, base, taxes, tax, total: input.pricesIncludeTax ? net : net + tax };
  });

  const summary = new Map<string, TaxSummary>();
  input.lines.forEach((l, i) => {
    const priced = lines[i];
    l.taxes.forEach((t, j) => {
      const s = summary.get(t.id) ?? { id: t.id, name: t.name, rateBp: t.rateBp, taxable: 0, amount: 0 };
      s.taxable += priced.base;
      s.amount += priced.taxes[j].amount;
      summary.set(t.id, s);
    });
  });

  const sum = (f: (l: PricedLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  return {
    lines,
    taxes: [...summary.values()],
    totals: { subtotal: sum((l) => l.gross), discountTotal: sum((l) => l.discount), taxTotal: sum((l) => l.tax), total: sum((l) => l.total) },
  };
}
