import type { Sale, ShiftReport } from '../api/pos-api';

/**
 * The open shift's report kept current on the till while offline: the same sums the server's Z
 * report makes, updated as each offline sale, refund, void or cash movement is recorded. The
 * server recomputes everything from its ledgers once the ops arrive; this is what the till shows meanwhile.
 */

export function openedOffline(id: string, registerId: string, openingFloat: number, at: Date): ShiftReport {
  return {
    shift: { id, registerId, status: 'OPEN', openedAt: at.toISOString(), closedAt: null, openingFloat, countedCash: null, variance: null, note: null },
    sales: { count: 0, subtotal: 0, discountTotal: 0, taxTotal: 0, total: 0, rounding: 0 },
    voids: { count: 0, total: 0 },
    refunds: { count: 0, total: 0 },
    payments: [],
    refundsByMethod: [],
    cash: { openingFloat, sales: 0, refunds: 0, payIns: 0, payOuts: 0, expected: openingFloat },
    movements: [],
  };
}

const bump = (rows: { method: string; amount: number }[], method: string, delta: number) => {
  const out = rows.map((r) => ({ ...r }));
  const row = out.find((r) => r.method === method);
  if (row) row.amount += delta;
  else out.push({ method, amount: delta });
  return out.filter((r) => r.amount !== 0);
};

const withExpected = (r: ShiftReport): ShiftReport => ({
  ...r,
  cash: { ...r.cash, expected: r.cash.openingFloat + r.cash.sales - r.cash.refunds + r.cash.payIns - r.cash.payOuts },
});

const cashPaid = (s: Pick<Sale, 'payments'>) => s.payments.filter((p) => p.method === 'CASH').reduce((t, p) => t + p.amount, 0);

export function addSale(r: ShiftReport, s: Pick<Sale, 'subtotal' | 'discountTotal' | 'taxTotal' | 'total' | 'rounding' | 'payments'>): ShiftReport {
  let payments = r.payments;
  for (const p of s.payments) payments = bump(payments, p.method, p.amount);
  return withExpected({
    ...r,
    sales: {
      count: r.sales.count + 1, subtotal: r.sales.subtotal + s.subtotal, discountTotal: r.sales.discountTotal + s.discountTotal,
      taxTotal: r.sales.taxTotal + s.taxTotal, total: r.sales.total + s.total, rounding: r.sales.rounding + s.rounding,
    },
    payments,
    cash: { ...r.cash, sales: r.cash.sales + cashPaid(s) },
  });
}

/** A voided sale leaves the sales and payment sums and is counted as a void. */
export function addVoid(r: ShiftReport, s: Pick<Sale, 'subtotal' | 'discountTotal' | 'taxTotal' | 'total' | 'rounding' | 'due' | 'payments'>): ShiftReport {
  let payments = r.payments;
  for (const p of s.payments) payments = bump(payments, p.method, -p.amount);
  return withExpected({
    ...r,
    sales: {
      count: r.sales.count - 1, subtotal: r.sales.subtotal - s.subtotal, discountTotal: r.sales.discountTotal - s.discountTotal,
      taxTotal: r.sales.taxTotal - s.taxTotal, total: r.sales.total - s.total, rounding: r.sales.rounding - s.rounding,
    },
    voids: { count: r.voids.count + 1, total: r.voids.total + s.due },
    payments,
    cash: { ...r.cash, sales: r.cash.sales - cashPaid(s) },
  });
}

export function addRefund(r: ShiftReport, method: string, paidOut: number): ShiftReport {
  return withExpected({
    ...r,
    refunds: { count: r.refunds.count + 1, total: r.refunds.total + paidOut },
    refundsByMethod: bump(r.refundsByMethod, method, paidOut),
    cash: { ...r.cash, refunds: r.cash.refunds + (method === 'CASH' ? paidOut : 0) },
  });
}

export function addCash(r: ShiftReport, type: 'PAY_IN' | 'PAY_OUT' | 'NO_SALE', amount: number, reason: string, at: Date): ShiftReport {
  return withExpected({
    ...r,
    movements: [...r.movements, { type, amount, reason, createdAt: at.toISOString() }],
    cash: { ...r.cash, payIns: r.cash.payIns + (type === 'PAY_IN' ? amount : 0), payOuts: r.cash.payOuts + (type === 'PAY_OUT' ? amount : 0) },
  });
}

export function closedOffline(r: ShiftReport, countedCash: number, note: string | undefined, at: Date): ShiftReport {
  return {
    ...r,
    shift: { ...r.shift, status: 'CLOSED', closedAt: at.toISOString(), countedCash, variance: countedCash - r.cash.expected, note: note ?? null },
  };
}
