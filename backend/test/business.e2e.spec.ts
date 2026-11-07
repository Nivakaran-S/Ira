import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PERMISSIONS } from '@pos/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { enrollTestDevice } from './helpers/device.js';
import { ADMIN_HOST, createRegister, createStore, createSuperAdmin, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword, loginSuperAdmin } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';
import { createProduct, TestTill } from './helpers/till.js';

const PW = 'correct horse battery staple';
const BUSINESS = ['core', 'customers', 'batch-expiry', 'multi-store', 'purchasing'];
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('business modules', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('biz');
  let tenantId: string;
  let storeA: string;
  let storeB: string;
  let owner: string;
  let ownerUserId: string;
  const asOwner = (r: request.Test) => r.set('Host', host).set(bearer(owner));
  const level = async (storeId: string, productId: string) =>
    (await ownerDb().stockLevel.findUnique({ where: { storeId_productId: { storeId, productId } } }))?.qtyMilli ?? 0;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  async function setup(modules = BUSINESS) {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'biz', modules, maxStores: 5 })).id;
    ownerUserId = (await createUser(tenantId, { email: 'owner@biz.lk', password: PW, permissions: [...PERMISSIONS] })).user.id;
    owner = await loginPassword(app, 'biz', 'owner@biz.lk', PW);
    storeA = (await asOwner(http().post('/api/stores')).send({ name: 'Colombo', code: 'COL' }).expect(201)).body.id;
  }

  it('a second store needs the multi-store module', async () => {
    await setup(['core']);
    const res = await asOwner(http().post('/api/stores')).send({ name: 'Kandy', code: 'KDY' }).expect(403);
    expect(res.body).toMatchObject({ code: 'MODULE_DISABLED', details: { module: 'multi-store' } });
  });

  describe('with business modules', () => {
    beforeEach(async () => {
      await setup();
      storeB = (await asOwner(http().post('/api/stores')).send({ name: 'Kandy', code: 'KDY' }).expect(201)).body.id;
    });

    it('store prices apply at that store only; staff can be limited to stores', async () => {
      const tea = await createProduct(tenantId, { name: 'Tea', price: 1_000 });
      await asOwner(http().put(`/api/stores/${storeA}/prices`)).send({ prices: [{ productId: tea.id, price: 900 }] }).expect(200);
      const regA = await createRegister(tenantId, storeA, { code: 'A1' });
      const regB = await createRegister(tenantId, storeB, { code: 'B1' });
      const cashier = await createUser(tenantId, { name: 'Ama', pin: '1234', permissions: ['sale.create'] });
      const kandyOnly = await createUser(tenantId, { name: 'Kumar', pin: '4321', permissions: ['sale.create'] });
      await asOwner(http().put(`/api/users/${kandyOnly.user.id}/stores`)).send({ storeIds: [storeB] }).expect(200);

      const tillA = await new TestTill(app, host, await enrollTestDevice(tenantId, regA.id, ownerUserId)).login(cashier.user.id, '1234');
      const tillB = await new TestTill(app, host, await enrollTestDevice(tenantId, regB.id, ownerUserId)).login(cashier.user.id, '1234');
      await tillA.openShift().expect(201);
      await tillB.openShift().expect(201);
      const sell = (t: TestTill, total: number) => t.sell({ lines: [{ productId: tea.id, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: total }], expectedTotal: total });
      expect((await sell(tillA, 900)).status).toBe(200);
      expect((await sell(tillB, 1_000)).status).toBe(200);
      expect((await tillA.call('GET', '/api/pos/catalog').expect(200)).body.products[0].price).toBe(900);
      expect((await tillA.call('GET', '/api/pos/sync/down').expect(200)).body.products[0].price).toBe(900);

      const padA = (await tillA.call('GET', '/api/users/pin-pad').expect(200)).body.map((u: { name: string }) => u.name);
      const padB = (await tillB.call('GET', '/api/users/pin-pad').expect(200)).body.map((u: { name: string }) => u.name);
      expect(padA).not.toContain('Kumar');
      expect(padB).toContain('Kumar');
    });

    it('purchase orders: receive in parts into stock and lots, cost follows the price paid', async () => {
      const rice = await createProduct(tenantId, { name: 'Rice', price: 300 });
      const syrup = await createProduct(tenantId, { name: 'Syrup', price: 900 });
      await ownerDb().product.update({ where: { id: syrup.id }, data: { tracksBatches: true } });
      const supplier = await asOwner(http().post('/api/suppliers')).send({ name: 'Lanka Wholesale', phone: '0112345678' }).expect(201);
      const po = await asOwner(http().post('/api/purchase-orders'))
        .send({ supplierId: supplier.body.id, storeId: storeA, lines: [{ productId: rice.id, qtyMilli: 10_000, unitCost: 200 }, { productId: syrup.id, qtyMilli: 5_000, unitCost: 600 }] })
        .expect(201);
      expect(po.body.number).toBe('PO-000001');
      const [riceLine, syrupLine] = po.body.lines;
      await asOwner(http().post(`/api/purchase-orders/${po.body.id}/receive`)).send({ lines: [{ lineId: riceLine.id, qtyMilli: 1_000 }] }).expect(409); // not sent yet
      await asOwner(http().post(`/api/purchase-orders/${po.body.id}/order`)).expect(200);

      await asOwner(http().post(`/api/purchase-orders/${po.body.id}/receive`)).send({ lines: [{ lineId: syrupLine.id, qtyMilli: 5_000 }] }).expect(400); // lot needed
      const part = await asOwner(http().post(`/api/purchase-orders/${po.body.id}/receive`))
        .send({ lines: [{ lineId: riceLine.id, qtyMilli: 6_000 }, { lineId: syrupLine.id, qtyMilli: 5_000, lotNo: 'S1', expiresOn: iso(200) }] })
        .expect(200);
      expect(part.body.status).toBe('PARTIAL');
      expect(await level(storeA, rice.id)).toBe(6_000);
      expect((await ownerDb().batch.findFirstOrThrow({ where: { productId: syrup.id } })).qtyMilli).toBe(5_000);
      expect((await ownerDb().product.findUniqueOrThrow({ where: { id: rice.id } })).costPrice).toBe(200);
      await asOwner(http().post(`/api/purchase-orders/${po.body.id}/receive`)).send({ lines: [{ lineId: riceLine.id, qtyMilli: 5_000 }] }).expect(409);
      const done = await asOwner(http().post(`/api/purchase-orders/${po.body.id}/receive`)).send({ lines: [{ lineId: riceLine.id, qtyMilli: 4_000 }] }).expect(200);
      expect(done.body.status).toBe('RECEIVED');
      await asOwner(http().post(`/api/purchase-orders/${po.body.id}/cancel`)).expect(409);
    });

    it('transfers move stock and lots between stores, record shortfalls, and can be cancelled in transit', async () => {
      const syrup = await createProduct(tenantId, { name: 'Syrup', price: 900 });
      await ownerDb().product.update({ where: { id: syrup.id }, data: { tracksBatches: true } });
      await asOwner(http().post('/api/batches/receive')).send({ storeId: storeA, productId: syrup.id, lotNo: 'L1', expiresOn: iso(30), qtyMilli: 4_000 }).expect(201);
      await asOwner(http().post('/api/batches/receive')).send({ storeId: storeA, productId: syrup.id, lotNo: 'L2', expiresOn: iso(90), qtyMilli: 4_000 }).expect(201);

      const t = await asOwner(http().post('/api/transfers')).send({ fromStoreId: storeA, toStoreId: storeB, lines: [{ productId: syrup.id, qtyMilli: 5_000 }] }).expect(201);
      expect(t.body.number).toBe('TR-000001');
      expect(await level(storeA, syrup.id)).toBe(3_000);
      // One unit broke on the way.
      await asOwner(http().post(`/api/transfers/${t.body.id}/receive`)).send({ lines: [{ lineId: t.body.lines[0].id, receivedQtyMilli: 4_000 }] }).expect(200);
      expect(await level(storeB, syrup.id)).toBe(4_000);
      const lotsB = await ownerDb().batch.findMany({ where: { storeId: storeB }, orderBy: { lotNo: 'asc' } });
      expect(lotsB.map((b) => [b.lotNo, b.qtyMilli])).toEqual([['L1', 4_000]]);
      await asOwner(http().post(`/api/transfers/${t.body.id}/cancel`)).expect(409);

      const t2 = await asOwner(http().post('/api/transfers')).send({ fromStoreId: storeA, toStoreId: storeB, lines: [{ productId: syrup.id, qtyMilli: 1_000 }] }).expect(201);
      await asOwner(http().post(`/api/transfers/${t2.body.id}/cancel`)).expect(200);
      expect(await level(storeA, syrup.id)).toBe(3_000);
      expect((await ownerDb().batch.findFirstOrThrow({ where: { storeId: storeA, lotNo: 'L2' } })).qtyMilli).toBe(3_000);
    });

    it('analytics: margin by product and cashier, stock value, low stock, CSV', async () => {
      const tea = await createProduct(tenantId, { name: 'Tea', price: 1_000 });
      await ownerDb().product.update({ where: { id: tea.id }, data: { costPrice: 400, reorderPoint: 5_000 } });
      await asOwner(http().post('/api/stock/adjust')).send({ storeId: storeA, productId: tea.id, deltaMilli: 8_000, note: 'Opening' }).expect(201);
      const reg = await createRegister(tenantId, storeA, { code: 'A1' });
      const cashier = await createUser(tenantId, { name: 'Ama', pin: '1234', permissions: ['sale.create'] });
      const till = await new TestTill(app, host, await enrollTestDevice(tenantId, reg.id, ownerUserId)).login(cashier.user.id, '1234');
      await till.openShift().expect(201);
      await till.sell({ lines: [{ productId: tea.id, qtyMilli: 3_000 }], payments: [{ method: 'CARD', amount: 3_000 }], expectedTotal: 3_000 }).expect(200);

      const from = encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString());
      const to = encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString());
      const byProduct = await asOwner(http().get(`/api/reports/breakdown?from=${from}&to=${to}&by=product`)).expect(200);
      expect(byProduct.body).toEqual([{ key: tea.id, label: 'Tea', sales: 1, qtyMilli: 3_000, revenue: 3_000, cost: 1_200, margin: 1_800 }]);
      const byCashier = await asOwner(http().get(`/api/reports/breakdown?from=${from}&to=${to}&by=cashier`)).expect(200);
      expect(byCashier.body[0]).toMatchObject({ label: 'Ama', revenue: 3_000 });
      const byHour = await asOwner(http().get(`/api/reports/breakdown?from=${from}&to=${to}&by=hour`)).expect(200);
      expect(byHour.body[0].label).toMatch(/^\d{2}:00$/);

      const inv = await asOwner(http().get(`/api/reports/inventory?storeId=${storeA}`)).expect(200);
      expect(inv.body).toMatchObject({ totalValue: 2_000, low: [expect.objectContaining({ name: 'Tea', qtyMilli: 5_000 })] });

      const csv = await asOwner(http().get(`/api/reports/sales.csv?from=${from}&to=${to}`)).expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      const lines = csv.text.trim().split('\r\n');
      expect(lines[0]).toBe('receipt,soldAt,status,product,sku,qty,unitPrice,discount,tax,total,unitCost,payment,offline');
      expect(lines[1]).toMatch(/^A1-000001,.*,COMPLETED,Tea,,3,10,0,0,30,4,CARD,$/);
    });
  });

  describe('billing', () => {
    let admin: string;
    const asAdmin = (r: request.Test) => r.set('Host', ADMIN_HOST).set(bearer(admin));
    beforeEach(async () => {
      await setup();
      const secret = randomBytes(20);
      await createSuperAdmin({ email: 'root@platform.lk', password: PW, totpSecret: secret });
      admin = await loginSuperAdmin(app, 'root@platform.lk', PW, secret);
    });

    it('plans with limits; monthly invoices; overdue tenants are suspended and come back when paid', async () => {
      await asAdmin(http().post('/api/platform/plans'))
        .send({ key: 'pro', name: 'Pro', maxStores: 5, maxDevices: 20, maxUsers: 50, maxProducts: 2, priceMonthly: 1_500_000, currency: 'LKR', graceDays: 10 })
        .expect(201);
      await asAdmin(http().put(`/api/platform/tenants/${tenantId}/plan`)).send({ planKey: 'pro' }).expect(200);

      await asOwner(http().post('/api/products')).send({ name: 'One', price: 1 }).expect(201);
      await asOwner(http().post('/api/products')).send({ name: 'Two', price: 1 }).expect(201);
      const limit = await asOwner(http().post('/api/products')).send({ name: 'Three', price: 1 }).expect(403);
      expect(limit.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', details: { resource: 'products', max: 2 } });

      expect((await asAdmin(http().post('/api/platform/billing/run')).expect(200)).body).toEqual({ issued: 1, suspended: 0 });
      expect((await asAdmin(http().post('/api/platform/billing/run')).expect(200)).body.issued).toBe(0);
      const mine = await asOwner(http().get('/api/billing')).expect(200);
      expect(mine.body).toMatchObject({ plan: { key: 'pro', priceMonthly: 1_500_000 }, usage: { products: 2, stores: 1 }, limits: { products: 2 } });
      expect(mine.body.invoices).toHaveLength(1);

      // Unpaid well past the due date: suspended.
      await ownerDb().invoice.updateMany({ data: { dueOn: new Date(Date.now() - 20 * 86_400_000) } });
      expect((await asAdmin(http().post('/api/platform/billing/run')).expect(200)).body.suspended).toBe(1);
      await flushRedis();
      // Everything is closed except what the owner needs to pay.
      const blocked = await asOwner(http().get('/api/stores'));
      expect(blocked.body.code).toBe('TENANT_SUSPENDED');
      await asOwner(http().get('/api/billing')).expect(200);

      const invoice = (await asAdmin(http().get('/api/platform/invoices?status=DUE')).expect(200)).body[0];
      await asAdmin(http().post(`/api/platform/invoices/${invoice.id}/pay`)).send({ reference: 'BOC-TT-9921' }).expect(200);
      await flushRedis();
      await asOwner(http().get('/api/stores')).expect(200);
      expect((await ownerDb().tenant.findUniqueOrThrow({ where: { id: tenantId } })).suspendedReason).toBeNull();

      // Cannot move to a plan the tenant already outgrows.
      await asAdmin(http().post('/api/platform/plans')).send({ key: 'tiny', name: 'Tiny', maxStores: 1, maxDevices: 1, maxUsers: 1, maxProducts: 1, priceMonthly: 0 }).expect(201);
      const down = await asAdmin(http().put(`/api/platform/tenants/${tenantId}/plan`)).send({ planKey: 'tiny' }).expect(409);
      expect(down.body.details.over).toEqual(expect.arrayContaining(['products']));
      // Tenants cannot reach platform billing.
      await http().get('/api/platform/invoices').set('Host', host).set(bearer(owner)).expect(404);
    });
  });
});
