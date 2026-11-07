import type { NestExpressApplication } from '@nestjs/platform-express';
import { PERMISSIONS } from '@pos/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { enrollTestDevice } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';
import { createProduct, createSriLankaTaxes, setSettings, TestTill } from './helpers/till.js';

const PW = 'correct horse battery staple';

describe('core POS', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;
  let storeId: string;
  let registerId: string;
  let cashierId: string;
  let managerId: string;
  let till: TestTill;
  let owner: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme' })).id;
    storeId = (await createStore(tenantId, { code: 'COL' })).id;
    registerId = (await createRegister(tenantId, storeId, { code: 'T1' })).id;
    cashierId = (await createUser(tenantId, { name: 'Cashier', pin: '1234', permissions: ['sale.create'] })).user.id;
    managerId = (
      await createUser(tenantId, {
        name: 'Manager', pin: '9876',
        permissions: ['sale.create', 'sale.void', 'sale.refund', 'discount.apply', 'price.override', 'drawer.open', 'shift.close'],
      })
    ).user.id;
    await createUser(tenantId, { email: 'owner@acme.lk', password: PW, permissions: [...PERMISSIONS] });
    owner = await loginPassword(app, 'acme', 'owner@acme.lk', PW);
    const device = await enrollTestDevice(tenantId, registerId, managerId);
    till = await new TestTill(app, host, device).login(cashierId, '1234');
  });

  const asOwner = (r: request.Test) => r.set('Host', host).set(bearer(owner));

  describe('catalog', () => {
    it('manages tax rates, groups, categories and products; the till gets resolved tax stacks', async () => {
      const vat = await asOwner(http().post('/api/tax-rates')).send({ name: 'VAT', rateBp: 1800 }).expect(201);
      const sscl = await asOwner(http().post('/api/tax-rates')).send({ name: 'SSCL', rateBp: 250 }).expect(201);
      const group = await asOwner(http().post('/api/tax-groups')).send({ name: 'Standard', rateIds: [vat.body.id, sscl.body.id] }).expect(201);
      const cat = await asOwner(http().post('/api/categories')).send({ name: 'Drinks', color: '#0f766e' }).expect(201);
      const p = await asOwner(http().post('/api/products'))
        .send({ name: 'Iced coffee', sku: 'ICE-1', price: 85_000, categoryId: cat.body.id, taxGroupId: group.body.id })
        .expect(201);
      await asOwner(http().post('/api/products')).send({ name: 'Dup', sku: 'ICE-1', price: 1 }).expect(409);
      await asOwner(http().patch(`/api/products/${p.body.id}`)).send({ price: 90_000 }).expect(200);

      const catalog = await till.call('GET', '/api/pos/catalog').expect(200);
      expect(catalog.body).toMatchObject({ currency: 'LKR', settings: { pricesIncludeTax: true }, categories: [{ name: 'Drinks' }] });
      expect(catalog.body.products).toEqual([
        expect.objectContaining({
          name: 'Iced coffee', price: 90_000,
          taxes: [
            { id: vat.body.id, name: 'VAT', rateBp: 1800, compound: false },
            { id: sscl.body.id, name: 'SSCL', rateBp: 250, compound: false },
          ],
        }),
      ]);
      // Without a device signature the till catalog is refused.
      await http().get('/api/pos/catalog').set('Host', host).set(bearer(till.token!)).expect(401);
    });

    it('cashiers cannot manage the catalog', async () => {
      await createUser(tenantId, { email: 'c@acme.lk', password: PW, permissions: ['sale.create'] });
      const c = await loginPassword(app, 'acme', 'c@acme.lk', PW);
      await http().post('/api/products').set('Host', host).set(bearer(c)).send({ name: 'X', price: 1 }).expect(403);
    });
  });

  describe('selling', () => {
    let coffeeId: string;
    let cakeId: string;
    beforeEach(async () => {
      const { group } = await createSriLankaTaxes(tenantId);
      coffeeId = (await createProduct(tenantId, { name: 'Coffee', price: 1_000, taxGroupId: group.id })).id;
      cakeId = (await createProduct(tenantId, { name: 'Cake', price: 2_500 })).id;
    });

    it('refuses to sell without an open shift', async () => {
      const res = await till.sell({ lines: [{ productId: coffeeId, qtyMilli: 1000 }], payments: [{ method: 'CASH', amount: 1_000 }], expectedTotal: 1_000 });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SHIFT_NOT_OPEN');
    });

    it('completes a cash sale with change, tax carved out, stock decremented and audit written', async () => {
      await till.openShift(10_000).expect(201);
      const res = await till.sell({
        lines: [{ productId: coffeeId, qtyMilli: 2_000 }, { productId: cakeId, qtyMilli: 1_000 }],
        payments: [{ method: 'CASH', amount: 4_500, tendered: 5_000 }],
        expectedTotal: 4_500,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ receiptNo: 'T1-000001', status: 'COMPLETED', total: 4_500, due: 4_500, change: 500, taxTotal: 340 });
      expect(res.body.lines[0]).toMatchObject({ name: 'Coffee', qtyMilli: 2_000, net: 2_000, tax: 340 });
      expect(res.body.taxes).toEqual([
        expect.objectContaining({ name: 'VAT', amount: 299 }),
        expect.objectContaining({ name: 'SSCL', amount: 41 }),
      ]);
      const level = await ownerDb().stockLevel.findUnique({ where: { storeId_productId: { storeId, productId: coffeeId } } });
      expect(level?.qtyMilli).toBe(-2_000);
      expect(await ownerDb().auditEvent.count({ where: { tenantId, action: 'sale.completed' } })).toBe(1);

      const receipt = await till.call('GET', `/api/pos/sales/${res.body.id}/receipt`).expect(200);
      expect(receipt.body).toMatchObject({ title: 'RECEIPT', barcode: 'T1-000001', currency: 'LKR' });
      expect(receipt.body.totals).toContainEqual({ label: 'TOTAL LKR', value: '45.00', bold: true });
      expect(receipt.body.payments).toEqual([{ label: 'Cash', value: '50.00' }, { label: 'Change', value: '5.00' }]);
    });

    it('is idempotent on the client id', async () => {
      await till.openShift().expect(201);
      const body = { id: uuidv7(), lines: [{ productId: cakeId, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: 2_500, reference: 'A1' }], expectedTotal: 2_500 };
      const a = await till.call('POST', '/api/pos/sales', body).expect(200);
      const b = await till.call('POST', '/api/pos/sales', body).expect(200);
      expect(b.body.receiptNo).toBe(a.body.receiptNo);
      expect(await ownerDb().sale.count()).toBe(1);
    });

    it('rejects a total the server does not agree with, and payments that do not add up', async () => {
      await till.openShift().expect(201);
      const bad = await till.sell({ lines: [{ productId: cakeId, qtyMilli: 1_000 }], payments: [{ method: 'CASH', amount: 2_400 }], expectedTotal: 2_400 });
      expect(bad.status).toBe(409);
      expect(bad.body).toMatchObject({ code: 'TOTAL_MISMATCH', details: { expected: 2_400, actual: 2_500 } });
      const short = await till.sell({ lines: [{ productId: cakeId, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: 2_000 }], expectedTotal: 2_500 });
      expect(short.status).toBe(400);
      expect(short.body.code).toBe('PAYMENT_MISMATCH');
      const under = await till.sell({ lines: [{ productId: cakeId, qtyMilli: 1_000 }], payments: [{ method: 'CASH', amount: 2_500, tendered: 2_000 }], expectedTotal: 2_500 });
      expect(under.status).toBe(400);
    });

    it('rounds all-cash sales to the tenant unit, not card sales', async () => {
      await setSettings(tenantId, { cashRoundingUnit: 100 });
      const odd = (await createProduct(tenantId, { name: 'Odd', price: 1_249 })).id;
      await till.openShift().expect(201);
      const cash = await till.sell({ lines: [{ productId: odd, qtyMilli: 1_000 }], payments: [{ method: 'CASH', amount: 1_200 }], expectedTotal: 1_200 });
      expect(cash.body).toMatchObject({ total: 1_249, rounding: -49, due: 1_200 });
      const card = await till.sell({ lines: [{ productId: odd, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: 1_249 }], expectedTotal: 1_249 });
      expect(card.body).toMatchObject({ rounding: 0, due: 1_249 });
    });

    it('discounts: the cashier needs a manager; a manager acts alone below the threshold', async () => {
      await till.openShift().expect(201);
      const sale = { lines: [{ productId: cakeId, qtyMilli: 1_000, discount: { kind: 'percent', bp: 500 } }], payments: [{ method: 'CARD', amount: 2_375 }], expectedTotal: 2_375 };
      const denied = await till.sell(sale);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { action: 'discount.apply' } });
      const token = await till.stepUp(managerId, '9876', 'discount.apply');
      const ok = await till.sell(sale, { 'x-step-up-token': token });
      expect(ok.status).toBe(200);
      expect(ok.body.approvals).toEqual([{ action: 'discount.apply', approverId: managerId }]);
      // The approval is single use.
      expect((await till.sell(sale, { 'x-step-up-token': token })).status).toBe(403);

      await till.login(managerId, '9876');
      expect((await till.sell(sale)).status).toBe(200);
      // 20% is over the default 10% threshold: even a manager needs a second manager's approval.
      const big = { lines: [{ productId: cakeId, qtyMilli: 1_000, discount: { kind: 'percent', bp: 2_000 } }], payments: [{ method: 'CARD', amount: 2_000 }], expectedTotal: 2_000 };
      expect((await till.sell(big)).status).toBe(403);
    });

    it('price overrides always need an approval', async () => {
      await till.openShift().expect(201);
      const sale = { lines: [{ productId: cakeId, qtyMilli: 1_000, unitPrice: 2_000 }], payments: [{ method: 'CARD', amount: 2_000 }], expectedTotal: 2_000 };
      expect((await till.sell(sale)).body.code).toBe('STEP_UP_REQUIRED');
      const token = await till.stepUp(managerId, '9876', 'price.override');
      const ok = await till.sell(sale, { 'x-step-up-token': token });
      expect(ok.status).toBe(200);
      expect(ok.body.lines[0]).toMatchObject({ unitPrice: 2_000, listPrice: 2_500 });
    });

    it('voids within the open shift with an approval, restoring stock', async () => {
      await till.openShift().expect(201);
      const sale = await till.sell({ lines: [{ productId: cakeId, qtyMilli: 2_000 }], payments: [{ method: 'CASH', amount: 5_000 }], expectedTotal: 5_000 });
      const path = `/api/pos/sales/${sale.body.id}/void`;
      expect((await till.call('POST', path, { reason: 'Wrong item' })).body.code).toBe('STEP_UP_REQUIRED');
      const token = await till.stepUp(managerId, '9876', 'sale.void');
      const voided = await till.call('POST', path, { reason: 'Wrong item' }, { 'x-step-up-token': token }).expect(200);
      expect(voided.body.status).toBe('VOIDED');
      const level = await ownerDb().stockLevel.findUnique({ where: { storeId_productId: { storeId, productId: cakeId } } });
      expect(level?.qtyMilli).toBe(0);
      const again = await till.call('POST', path, { reason: 'x2x' }, { 'x-step-up-token': await till.stepUp(managerId, '9876', 'sale.void') });
      expect(again.status).toBe(409);
    });

    it('refunds part by part; the parts add up exactly to the line, never more', async () => {
      await till.openShift(100_000).expect(201);
      const odd = (await createProduct(tenantId, { name: 'Odd', price: 1_000 })).id;
      const sale = await till.sell({
        lines: [{ productId: odd, qtyMilli: 3_000 }],
        cartDiscount: { kind: 'amount', amount: 1 },
        payments: [{ method: 'CASH', amount: 2_999 }],
        expectedTotal: 2_999,
      }, { 'x-step-up-token': await till.stepUp(managerId, '9876', 'discount.apply') });
      expect(sale.status).toBe(200);
      const lineId = sale.body.lines[0].id;
      const refund = async (qtyMilli: number) =>
        till.call('POST', '/api/pos/refunds', { id: uuidv7(), saleId: sale.body.id, lines: [{ saleLineId: lineId, qtyMilli }], method: 'CASH', reason: 'Damaged' }, {
          'x-step-up-token': await till.stepUp(managerId, '9876', 'sale.refund'),
        });
      const r1 = await refund(1_000);
      const r2 = await refund(1_000);
      const r3 = await refund(1_000);
      expect([r1.status, r2.status, r3.status]).toEqual([200, 200, 200]);
      expect(r1.body.total + r2.body.total + r3.body.total).toBe(2_999);
      expect(r1.body.receiptNo).toMatch(/^RT1-\d{6}$/);
      expect((await refund(1)).status).toBe(409);
      const level = await ownerDb().stockLevel.findUnique({ where: { storeId_productId: { storeId, productId: odd } } });
      expect(level?.qtyMilli).toBe(0);
      const rr = await till.call('GET', `/api/pos/refunds/${r1.body.id}/receipt`).expect(200);
      expect(rr.body.title).toBe('REFUND');
    });

    it('refunds without sale.refund need approval; the drawer must hold the cash', async () => {
      await till.openShift(0).expect(201);
      const card = await till.sell({ lines: [{ productId: cakeId, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: 2_500 }], expectedTotal: 2_500 });
      const body = { id: uuidv7(), saleId: card.body.id, lines: [{ saleLineId: card.body.lines[0].id, qtyMilli: 1_000 }], method: 'CASH', reason: 'Changed mind' };
      expect((await till.call('POST', '/api/pos/refunds', body)).body.code).toBe('STEP_UP_REQUIRED');
      const res = await till.call('POST', '/api/pos/refunds', body, { 'x-step-up-token': await till.stepUp(managerId, '9876', 'sale.refund') });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/drawer/);
      const toCard = await till.call('POST', '/api/pos/refunds', { ...body, id: uuidv7(), method: 'CARD' }, { 'x-step-up-token': await till.stepUp(managerId, '9876', 'sale.refund') });
      expect(toCard.status).toBe(200);
    });

    it('tracks cash through the shift and closes with a variance; the Z report adds up', async () => {
      await till.openShift(10_000).expect(201);
      await till.sell({ lines: [{ productId: cakeId, qtyMilli: 1_000 }], payments: [{ method: 'CASH', amount: 2_500, tendered: 3_000 }], expectedTotal: 2_500 }).expect(200);
      await till.sell({ lines: [{ productId: cakeId, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: 2_500 }], expectedTotal: 2_500 }).expect(200);

      expect((await till.call('POST', '/api/pos/shift/cash', { type: 'PAY_OUT', amount: 1_000, reason: 'Milk' })).body.code).toBe('STEP_UP_REQUIRED');
      await till.call('POST', '/api/pos/shift/cash', { type: 'PAY_OUT', amount: 1_000, reason: 'Milk' }, {
        'x-step-up-token': await till.stepUp(managerId, '9876', 'drawer.open'),
      }).expect(201);
      const tooMuch = await till.call('POST', '/api/pos/shift/cash', { type: 'PAY_OUT', amount: 999_999, reason: 'All' }, {
        'x-step-up-token': await till.stepUp(managerId, '9876', 'drawer.open'),
      });
      expect(tooMuch.status).toBe(409);

      await till.login(managerId, '9876');
      // A no-sale drawer open needs an approval even for staff holding drawer.open.
      expect((await till.call('POST', '/api/pos/shift/cash', { type: 'NO_SALE', reason: 'Change for 5000' })).body.code).toBe('STEP_UP_REQUIRED');

      const closed = await till.call('POST', '/api/pos/shift/close', { countedCash: 11_400 }).expect(200);
      expect(closed.body.cash).toEqual({ openingFloat: 10_000, sales: 2_500, refunds: 0, payIns: 0, payOuts: 1_000, expected: 11_500 });
      expect(closed.body.shift).toMatchObject({ status: 'CLOSED', countedCash: 11_400, variance: -100 });
      expect(closed.body.sales).toMatchObject({ count: 2, total: 5_000 });
      expect(closed.body.payments).toEqual(expect.arrayContaining([{ method: 'CASH', amount: 2_500 }, { method: 'CARD', amount: 2_500 }]));
      expect((await till.call('GET', '/api/pos/shift')).body).toEqual({ shift: null });
    });

    it('reports for the back office and isolates tenants', async () => {
      await till.openShift().expect(201);
      const s = await till.sell({ lines: [{ productId: coffeeId, qtyMilli: 1_000 }, { productId: cakeId, qtyMilli: 2_000 }], payments: [{ method: 'CARD', amount: 6_000 }], expectedTotal: 6_000 });
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const to = new Date(Date.now() + 3_600_000).toISOString();
      const rep = await asOwner(http().get(`/api/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).expect(200);
      expect(rep.body).toMatchObject({ currency: 'LKR', sales: { count: 1, total: 6_000 }, net: 6_000, payments: [{ method: 'CARD', amount: 6_000 }] });
      expect(rep.body.topProducts[0]).toMatchObject({ name: 'Cake', qtyMilli: 2_000, total: 5_000 });
      expect(rep.body.byDay).toHaveLength(1);
      expect((await asOwner(http().get('/api/sales')).expect(200)).body).toHaveLength(1);

      const other = await createTenant({ slug: 'other' });
      await createUser(other.id, { email: 'o@other.lk', password: PW, permissions: [...PERMISSIONS] });
      const otherOwner = await loginPassword(app, 'other', 'o@other.lk', PW);
      await http().get(`/api/sales/${s.body.id}`).set('Host', hostFor('other')).set(bearer(otherOwner)).expect(404);
      expect((await http().get('/api/sales').set('Host', hostFor('other')).set(bearer(otherOwner)).expect(200)).body).toEqual([]);
    });

    it('lists approvers for an action', async () => {
      const res = await till.call('GET', '/api/pos/approvers?action=sale.void').expect(200);
      expect(res.body).toEqual([{ id: managerId, name: 'Manager' }]);
    });
  });

  describe('settings', () => {
    it('owners update settings; everyone reads them', async () => {
      const s = (await asOwner(http().get('/api/settings')).expect(200)).body;
      expect(s).toMatchObject({ pricesIncludeTax: true, currency: 'LKR' });
      await asOwner(http().put('/api/settings')).send({ ...s, currency: undefined, pricesIncludeTax: false, cashRoundingUnit: 100 }).expect(200);
      expect((await till.call('GET', '/api/settings').expect(200)).body).toMatchObject({ pricesIncludeTax: false, cashRoundingUnit: 100 });
      await till.call('PUT', '/api/settings', { pricesIncludeTax: true }).expect(403);
    });
  });
});
