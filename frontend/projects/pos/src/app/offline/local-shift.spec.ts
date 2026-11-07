import { describe, expect, it } from 'vitest';
import type { Sale } from '../api/pos-api';
import { addCash, addRefund, addSale, addVoid, closedOffline, openedOffline } from './local-shift';

const sale = (payments: Sale['payments'], total = 2_000, rounding = 0): Pick<Sale, 'subtotal' | 'discountTotal' | 'taxTotal' | 'total' | 'rounding' | 'due' | 'payments'> => ({
  subtotal: total, discountTotal: 0, taxTotal: 0, total, rounding, due: total + rounding, payments,
});
const pay = (method: Sale['payments'][number]['method'], amount: number) => ({ id: 'p', method, amount, tendered: null, change: 0, reference: null });

describe('local shift report', () => {
  it('adds up like the server: float + cash sales − cash refunds + pay-ins − pay-outs; voids leave the sums', () => {
    const at = new Date('2026-11-08T03:00:00Z');
    let r = openedOffline('s1', 'r1', 5_000, at);
    r = addSale(r, sale([pay('CASH', 2_000)]));
    r = addSale(r, sale([pay('CARD', 1_000), pay('CASH', 1_000)]));
    const voided = sale([pay('CASH', 1_500)], 1_500);
    r = addSale(r, voided);
    r = addVoid(r, voided);
    r = addRefund(r, 'CASH', 500);
    r = addRefund(r, 'CARD', 300);
    r = addCash(r, 'PAY_IN', 1_000, 'Change from bank', at);
    r = addCash(r, 'PAY_OUT', 200, 'Milk', at);
    expect(r.sales).toMatchObject({ count: 2, total: 4_000 });
    expect(r.voids).toEqual({ count: 1, total: 1_500 });
    expect(r.payments).toEqual([{ method: 'CASH', amount: 3_000 }, { method: 'CARD', amount: 1_000 }]);
    expect(r.refunds).toEqual({ count: 2, total: 800 });
    expect(r.cash).toEqual({ openingFloat: 5_000, sales: 3_000, refunds: 500, payIns: 1_000, payOuts: 200, expected: 8_300 });
    const z = closedOffline(r, 8_000, 'short', at);
    expect(z.shift).toMatchObject({ status: 'CLOSED', countedCash: 8_000, variance: -300, note: 'short' });
  });
});
