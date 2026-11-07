import { webcrypto } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { GENESIS, type OfflineOp, opHash, PERMISSIONS } from '@pos/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { enrollTestDevice, type TestDevice } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';
import { createProduct, setSettings, TestTill } from './helpers/till.js';

const PW = 'correct horse battery staple';
const RETAIL = ['core', 'customers', 'variants', 'barcodes', 'promotions', 'loyalty'];

describe('retail modules', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;
  let storeId: string;
  let registerId: string;
  let cashierId: string;
  let managerId: string;
  let device: TestDevice;
  let till: TestTill;
  let owner: string;
  const asOwner = (r: request.Test) => r.set('Host', host).set(bearer(owner));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  async function setup(modules = RETAIL) {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme', modules })).id;
    storeId = (await createStore(tenantId)).id;
    registerId = (await createRegister(tenantId, storeId, { code: 'T1' })).id;
    cashierId = (await createUser(tenantId, { name: 'Cashier', pin: '1234', permissions: ['sale.create'] })).user.id;
    managerId = (await createUser(tenantId, { name: 'Manager', pin: '9876', permissions: ['sale.create', 'sale.refund', 'sale.void', 'discount.apply'] })).user.id;
    await createUser(tenantId, { email: 'owner@acme.lk', password: PW, permissions: [...PERMISSIONS] });
    owner = await loginPassword(app, 'acme', 'owner@acme.lk', PW);
    device = await enrollTestDevice(tenantId, registerId, managerId);
    till = await new TestTill(app, host, device).login(cashierId, '1234');
    await till.openShift(100_000).expect(201);
  }

  const cardSale = (lines: { productId: string; qtyMilli: number }[], total: number, extra: Record<string, unknown> = {}) =>
    till.sell({ lines, payments: [{ method: 'CARD', amount: total }], expectedTotal: total, ...extra });

  describe('module gating', () => {
    beforeEach(() => setup(['core']));
    it('refuses retail endpoints when the modules are off', async () => {
      const res = await asOwner(http().get('/api/customers')).expect(403);
      expect(res.body).toMatchObject({ code: 'MODULE_DISABLED', details: { module: 'customers' } });
      await asOwner(http().get('/api/promotions')).expect(403);
      const p = await createProduct(tenantId, { price: 100 });
      await asOwner(http().put(`/api/products/${p.id}/barcodes`)).send({ codes: ['123456'] }).expect(403);
      await asOwner(http().post(`/api/products/${p.id}/variants`)).send({ variants: [{ variantLabel: 'Red' }] }).expect(403);
      const sale = await cardSale([{ productId: p.id, qtyMilli: 1000 }], 100, { customerId: uuidv7() });
      expect(sale.body.code).toBe('MODULE_DISABLED');
    });
  });

  describe('with retail modules', () => {
    beforeEach(() => setup());

    it('variants are products of a family; the family itself is not sold; barcodes find them', async () => {
      const shirt = await asOwner(http().post('/api/products')).send({ name: 'T-shirt', price: 2_000 }).expect(201);
      const v = await asOwner(http().post(`/api/products/${shirt.body.id}/variants`))
        .send({ variants: [{ variantLabel: 'S', barcode: '4790000000017' }, { variantLabel: 'L', price: 2_200, sku: 'TS-L' }] })
        .expect(201);
      expect(v.body.map((p: { name: string; price: number }) => [p.name, p.price])).toEqual([['T-shirt - S', 2_000], ['T-shirt - L', 2_200]]);
      await asOwner(http().put(`/api/products/${v.body[1].id}/barcodes`)).send({ codes: ['4790000000024', 'TSL'] }).expect(200);
      await asOwner(http().put(`/api/products/${v.body[0].id}/barcodes`)).send({ codes: ['TSL'] }).expect(409);
      await asOwner(http().put(`/api/products/${shirt.body.id}/barcodes`)).send({ codes: ['X1X'] }).expect(409);

      const found = await till.call('GET', '/api/pos/barcodes/4790000000024').expect(200);
      expect(found.body).toMatchObject({ id: v.body[1].id, price: 2_200 });
      await till.call('GET', '/api/pos/barcodes/0000000').expect(404);

      expect((await cardSale([{ productId: shirt.body.id, qtyMilli: 1000 }], 2_000)).body).toMatchObject({ code: 'INVALID_STATE' });
      expect((await cardSale([{ productId: v.body[1].id, qtyMilli: 1000 }], 2_200)).status).toBe(200);

      const down = await till.call('GET', '/api/pos/sync/down').expect(200);
      expect(down.body.modules).toEqual(expect.arrayContaining(['variants', 'barcodes']));
      expect(down.body.barcodes).toEqual(expect.arrayContaining([{ code: 'TSL', productId: v.body[1].id }]));
      expect(down.body.products.find((p: { id: string }) => p.id === shirt.body.id)).toMatchObject({ hasVariants: true });
    });

    it('stores phone and email encrypted, finds customers by phone in any format, tills see only the last four digits', async () => {
      const c = await asOwner(http().post('/api/customers')).send({ name: 'Nimal Perera', phone: '077 123 4567', email: 'Nimal@Mail.lk' }).expect(201);
      expect(c.body).toMatchObject({ name: 'Nimal Perera', phone: '+94771234567', email: 'nimal@mail.lk' });
      const row = await ownerDb().customer.findUniqueOrThrow({ where: { id: c.body.id } });
      expect(JSON.stringify(row)).not.toMatch(/771234567|nimal@mail/);
      await asOwner(http().post('/api/customers')).send({ name: 'Dup', phone: '+94 77 123 4567' }).expect(409);

      const byPhone = await till.call('GET', '/api/pos/customers?q=%2B94771234567').expect(200);
      expect(byPhone.body).toEqual([{ id: c.body.id, name: 'Nimal Perera', phoneLast4: '4567', points: 0, credit: 0 }]);
      expect((await till.call('GET', '/api/pos/customers?q=nimal').expect(200)).body).toHaveLength(1);

      const other = await createTenant({ slug: 'other', modules: RETAIL });
      await createUser(other.id, { email: 'o@other.lk', password: PW, permissions: [...PERMISSIONS] });
      const otherOwner = await loginPassword(app, 'other', 'o@other.lk', PW);
      const res = await http().get('/api/customers?q=0771234567').set('Host', hostFor('other')).set(bearer(otherOwner)).expect(200);
      expect(res.body).toEqual([]);
    });

    it('promotions apply automatically, without manager approval, and show on the receipt', async () => {
      const cat = await asOwner(http().post('/api/categories')).send({ name: 'Drinks' }).expect(201);
      const tea = await asOwner(http().post('/api/products')).send({ name: 'Tea', price: 1_000, categoryId: cat.body.id }).expect(201);
      const soap = await createProduct(tenantId, { name: 'Soap', price: 300 });
      await asOwner(http().post('/api/promotions')).send({ name: 'Drinks 25% off', kind: 'PERCENT_OFF', percentBp: 2_500, categoryIds: [cat.body.id] }).expect(201);
      await asOwner(http().post('/api/promotions')).send({ name: 'Soap 2+1', kind: 'BUY_X_GET_Y', buyQty: 2, getQty: 1, productIds: [soap.id] }).expect(201);
      await asOwner(http().post('/api/promotions')).send({ name: 'Bad', kind: 'PERCENT_OFF' }).expect(400);

      // Without the promotion the till would say 2000 + 900; the server applies the same rules.
      const wrong = await cardSale([{ productId: tea.body.id, qtyMilli: 2_000 }, { productId: soap.id, qtyMilli: 3_000 }], 2_900);
      expect(wrong.body).toMatchObject({ code: 'TOTAL_MISMATCH', details: { actual: 2_100 } });
      const ok = await cardSale([{ productId: tea.body.id, qtyMilli: 2_000 }, { productId: soap.id, qtyMilli: 3_000 }], 2_100);
      expect(ok.status).toBe(200);
      expect(ok.body.approvals).toEqual([]);
      expect(ok.body.promotions).toEqual(
        expect.arrayContaining([expect.objectContaining({ label: 'Drinks 25% off', amount: 500 }), expect.objectContaining({ label: 'Soap 2+1', amount: 300 })]),
      );
      const receipt = await till.call('GET', `/api/pos/sales/${ok.body.id}/receipt`).expect(200);
      expect(receipt.body.totals).toContainEqual({ label: 'Drinks 25% off', value: '-5.00' });
      expect(receipt.body.totals.find((t: { label: string }) => t.label === 'Discounts')).toBeUndefined();
    });

    it('loyalty: earns on what was paid, redeems in whole points, voids and refunds give back exactly', async () => {
      await setSettings(tenantId, { loyalty: { earnSpend: 1_000, pointValue: 10, minRedeemPoints: 10 } });
      const c = await asOwner(http().post('/api/customers')).send({ name: 'Kumari', phone: '0712345678' }).expect(201);
      const p = await createProduct(tenantId, { name: 'Rice', price: 5_000 });

      const s1 = await cardSale([{ productId: p.id, qtyMilli: 2_000 }], 10_000, { customerId: c.body.id });
      expect(s1.body).toMatchObject({ customerId: c.body.id, loyaltyEarned: 10 });
      // Not enough points yet for 200 (20 points)... she has 10.
      const tooMuch = await till.sell({
        customerId: c.body.id, lines: [{ productId: p.id, qtyMilli: 1_000 }],
        payments: [{ method: 'LOYALTY', amount: 200 }, { method: 'CARD', amount: 4_800 }], expectedTotal: 5_000,
      });
      expect(tooMuch.body.code).toBe('INVALID_STATE');
      const notWhole = await till.sell({
        customerId: c.body.id, lines: [{ productId: p.id, qtyMilli: 1_000 }],
        payments: [{ method: 'LOYALTY', amount: 105 }, { method: 'CARD', amount: 4_895 }], expectedTotal: 5_000,
      });
      expect(notWhole.status).toBe(400);
      const redeem = await till.sell({
        customerId: c.body.id, lines: [{ productId: p.id, qtyMilli: 1_000 }],
        payments: [{ method: 'LOYALTY', amount: 100 }, { method: 'CARD', amount: 4_900 }], expectedTotal: 5_000,
      });
      expect(redeem.status).toBe(200);
      expect(redeem.body.loyaltyEarned).toBe(4); // earned on the 4,900 paid by card
      const bal = async () => (await till.call('GET', '/api/pos/customers?q=Kumari').expect(200)).body[0].points;
      expect(await bal()).toBe(10 - 10 + 4);

      // Void the redeeming sale: the 10 points come back and the 4 earned go away.
      const v = await till.call('POST', `/api/pos/sales/${redeem.body.id}/void`, { reason: 'Mistake' }, { 'x-step-up-token': await till.stepUp(managerId, '9876', 'sale.void') });
      expect(v.status).toBe(200);
      expect(await bal()).toBe(10);

      // Refund half of the first sale: half of its 10 points are reversed.
      const r = await till.call('POST', '/api/pos/refunds', {
        id: uuidv7(), saleId: s1.body.id, lines: [{ saleLineId: s1.body.lines[0].id, qtyMilli: 1_000 }], method: 'CARD', reason: 'Spoiled',
      }, { 'x-step-up-token': await till.stepUp(managerId, '9876', 'sale.refund') });
      expect(r.status).toBe(200);
      expect(await bal()).toBe(5);
      const detail = await asOwner(http().get(`/api/customers/${c.body.id}`)).expect(200);
      expect(detail.body.loyaltyLedger.map((l: { reason: string }) => l.reason)).toEqual(expect.arrayContaining(['EARN', 'REDEEM', 'RESTORE', 'REVERSE']));
    });

    it('store credit: refund to credit, spend it later; no customer, no credit', async () => {
      const c = await asOwner(http().post('/api/customers')).send({ name: 'Ravi' }).expect(201);
      const p = await createProduct(tenantId, { name: 'Lamp', price: 3_000 });
      const sale = await cardSale([{ productId: p.id, qtyMilli: 1_000 }], 3_000, { customerId: c.body.id });
      const anon = await cardSale([{ productId: p.id, qtyMilli: 1_000 }], 3_000);
      const refundTo = (s: { body: { id: string; lines: { id: string }[] } }) => async () =>
        till.call('POST', '/api/pos/refunds', { id: uuidv7(), saleId: s.body.id, lines: [{ saleLineId: s.body.lines[0].id, qtyMilli: 1_000 }], method: 'STORE_CREDIT', reason: 'Changed mind' }, {
          'x-step-up-token': await till.stepUp(managerId, '9876', 'sale.refund'),
        });
      expect((await refundTo(anon)()).body.code).toBe('INVALID_STATE');
      expect((await refundTo(sale)()).status).toBe(200);
      const spend = await till.sell({
        customerId: c.body.id, lines: [{ productId: p.id, qtyMilli: 1_000 }],
        payments: [{ method: 'STORE_CREDIT', amount: 3_000 }], expectedTotal: 3_000,
      });
      expect(spend.status).toBe(200);
      expect((await till.call('GET', '/api/pos/customers?q=Ravi').expect(200)).body[0].credit).toBe(0);
      const again = await till.sell({
        customerId: c.body.id, lines: [{ productId: p.id, qtyMilli: 1_000 }],
        payments: [{ method: 'STORE_CREDIT', amount: 3_000 }], expectedTotal: 3_000,
      });
      expect(again.body.code).toBe('INVALID_STATE');
    });

    it('offline sales must carry the promotions the till knew', async () => {
      const cat = await asOwner(http().post('/api/categories')).send({ name: 'Drinks' }).expect(201);
      const tea = await asOwner(http().post('/api/products')).send({ name: 'Tea', price: 1_000, categoryId: cat.body.id }).expect(201);
      const promo = await asOwner(http().post('/api/promotions')).send({ name: 'Tea 10%', kind: 'PERCENT_OFF', percentBp: 1_000, categoryIds: [cat.body.id] }).expect(201);
      const down = await till.call('GET', '/api/pos/sync/down').expect(200);
      expect(down.body.promotions).toEqual([expect.objectContaining({ id: promo.body.id, name: 'Tea 10%' })]);
      const shift = await ownerDb().shift.findFirstOrThrow({ where: { registerId } });

      let seq = 0;
      let prev = GENESIS;
      const op = async (payload: Record<string, unknown>) => {
        const base = { kind: 'sale', seq: ++seq, prevHash: prev, createdAt: new Date().toISOString(), payload } as unknown as OfflineOp;
        const hash = await opHash(base);
        const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, new TextEncoder().encode(hash))).toString('base64url');
        prev = hash;
        return { ...base, hash, sig };
      };
      const sale = (promoAmount: number | null, total: number) => ({
        id: uuidv7(), shiftId: shift.id, cashierId, receiptNo: `T1-O00000${seq + 1}`, catalogVersion: down.body.cursor,
        lines: [{ productId: tea.body.id, qtyMilli: 1_000, unitPrice: 1_000, listPrice: 1_000, taxes: [], ...(promoAmount ? { promo: { promotionId: promo.body.id, label: 'Tea 10%', amount: promoAmount } } : {}) }],
        payments: [{ method: 'CASH', amount: total }], expectedTotal: total, approvals: [],
      });
      const res = await till.call('POST', '/api/pos/sync/up', { ops: [await op(sale(100, 900)), await op(sale(null, 1_000)), await op(sale(300, 700))] }).expect(200);
      expect(res.body.results.map((r: { status: string; reason?: string }) => r.reason ?? r.status)).toEqual(['applied', 'PROMO_MISMATCH', 'PROMO_MISMATCH']);
    });
  });
});
