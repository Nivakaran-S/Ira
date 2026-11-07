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
import { createProduct, TestTill } from './helpers/till.js';

const PW = 'correct horse battery staple';
const PHARMACY = ['core', 'customers', 'barcodes', 'weighed-items', 'batch-expiry', 'prescriptions'];
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('grocery and pharmacy modules', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('rx');
  let tenantId: string;
  let storeId: string;
  let registerId: string;
  let cashierId: string;
  let pharmacistId: string;
  let device: TestDevice;
  let till: TestTill;
  let owner: string;
  const asOwner = (r: request.Test) => r.set('Host', host).set(bearer(owner));
  const card = (lines: Record<string, unknown>[], total: number, extra: Record<string, unknown> = {}) =>
    till.sell({ lines, payments: [{ method: 'CARD', amount: total }], expectedTotal: total, ...extra });

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'rx', modules: PHARMACY })).id;
    storeId = (await createStore(tenantId)).id;
    registerId = (await createRegister(tenantId, storeId, { code: 'P1' })).id;
    cashierId = (await createUser(tenantId, { name: 'Cashier', pin: '1234', permissions: ['sale.create'] })).user.id;
    pharmacistId = (await createUser(tenantId, { name: 'Pharmacist', pin: '7777', permissions: ['sale.create', 'prescription.dispense', 'sale.void', 'sale.refund'] })).user.id;
    await createUser(tenantId, { email: 'owner@rx.lk', password: PW, permissions: [...PERMISSIONS] });
    owner = await loginPassword(app, 'rx', 'owner@rx.lk', PW);
    device = await enrollTestDevice(tenantId, registerId, pharmacistId);
    till = await new TestTill(app, host, device).login(cashierId, '1234');
    await till.openShift(0).expect(201);
  });

  it('weighed items price by the kilo with gram quantities, and carry a PLU', async () => {
    const rice = await asOwner(http().post('/api/products')).send({ name: 'Red rice', price: 50_000, soldByWeight: true, plu: '01234' }).expect(201);
    expect(rice.body).toMatchObject({ soldByWeight: true, plu: '01234' });
    await asOwner(http().post('/api/products')).send({ name: 'Other', price: 1, plu: '01234' }).expect(409);
    const sale = await card([{ productId: rice.body.id, qtyMilli: 1_250 }], 62_500);
    expect(sale.status).toBe(200);
    const down = await till.call('GET', '/api/pos/sync/down').expect(200);
    expect(down.body.products[0]).toMatchObject({ soldByWeight: true, plu: '01234' });
  });

  it('lots: received with expiry, sold first-expiring-first, never expired, given back on void, traceable', async () => {
    const pills = await asOwner(http().post('/api/products')).send({ name: 'Paracetamol', price: 100, tracksBatches: true }).expect(201);
    const receive = (lotNo: string, expiresOn: string, qtyMilli: number) =>
      asOwner(http().post('/api/batches/receive')).send({ storeId, productId: pills.body.id, lotNo, expiresOn, qtyMilli });
    await receive('A', iso(10), 2_000).expect(201);
    await receive('B', iso(60), 5_000).expect(201);
    await receive('OLD', iso(-5), 9_000).expect(201);
    await receive('A', iso(11), 1_000).expect(409); // same lot, different date

    const sale = await card([{ productId: pills.body.id, qtyMilli: 3_000 }], 300);
    expect(sale.status).toBe(200);
    expect(sale.body.lines[0].batches.map((b: { lotNo: string; qtyMilli: number }) => [b.lotNo, b.qtyMilli])).toEqual([['A', 2_000], ['B', 1_000]]);
    const list = await asOwner(http().get(`/api/batches?storeId=${storeId}`)).expect(200);
    expect(list.body.map((l: { lotNo: string; qtyMilli: number; expired: boolean; expiringSoon: boolean }) => [l.lotNo, l.qtyMilli, l.expired, l.expiringSoon])).toEqual([
      ['OLD', 9_000, true, false],
      ['B', 4_000, false, false],
    ]);
    const lotA = await ownerDb().batch.findFirstOrThrow({ where: { lotNo: 'A' } });
    const recall = await asOwner(http().get(`/api/batches/${lotA.id}/sales`)).expect(200);
    expect(recall.body.sales).toEqual([expect.objectContaining({ saleId: sale.body.id, name: 'Paracetamol' })]);

    await till.login(pharmacistId, '7777');
    await till.call('POST', `/api/pos/sales/${sale.body.id}/void`, { reason: 'Wrong item' }, { 'x-step-up-token': await till.stepUp(pharmacistId, '7777', 'sale.void') }).expect(200);
    expect((await ownerDb().batch.findMany({ orderBy: { lotNo: 'asc' } })).map((b) => [b.lotNo, b.qtyMilli])).toEqual([['A', 2_000], ['B', 5_000], ['OLD', 9_000]]);
    const movements = await ownerDb().stockMovement.findMany({ where: { productId: pills.body.id, reason: 'SALE' } });
    expect(movements.every((m) => m.batchId)).toBe(true);
  });

  it('prescriptions: customer, prescription, pharmacist, quantity and age are all checked', async () => {
    const drug = await asOwner(http().post('/api/products')).send({ name: 'Amoxicillin', price: 500, rxRequired: true }).expect(201);
    const customer = await asOwner(http().post('/api/customers')).send({ name: 'Saman', phone: '0779998887' }).expect(201);
    const line = (extra: Record<string, unknown> = {}) => ({ productId: drug.body.id, qtyMilli: 1_000, ...extra });

    expect((await card([line()], 500)).body.message).toMatch(/customer/);
    expect((await card([line()], 500, { customerId: customer.body.id })).body.message).toMatch(/needs a prescription/);

    const rx = await asOwner(http().post('/api/prescriptions'))
      .send({ customerId: customer.body.id, prescriber: 'Dr. Perera', prescriberRegNo: 'SLMC 12345', issuedOn: iso(-2), items: [{ productId: drug.body.id, qtyMilli: 2_000, directions: '1 x 3 daily' }] })
      .expect(201);
    const itemId = rx.body.items[0].id;
    const asCashier = await card([line({ prescriptionItemId: itemId })], 500, { customerId: customer.body.id });
    expect(asCashier.body).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { action: 'prescription.dispense' } });

    await till.login(pharmacistId, '7777');
    expect((await card([line({ prescriptionItemId: itemId })], 500, { customerId: customer.body.id })).status).toBe(200);
    const tooMuch = await card([line({ prescriptionItemId: itemId, qtyMilli: 2_000 })], 1_000, { customerId: customer.body.id });
    expect(tooMuch.body.message).toMatch(/More than the prescription allows/);
    const listed = await till.call('GET', `/api/pos/prescriptions?customerId=${customer.body.id}`).expect(200);
    expect(listed.body[0].items[0]).toMatchObject({ qtyMilli: 2_000, dispensedQtyMilli: 1_000 });

    const old = await asOwner(http().post('/api/prescriptions'))
      .send({ customerId: customer.body.id, prescriber: 'Dr. Old', issuedOn: iso(-60), items: [{ productId: drug.body.id, qtyMilli: 1_000 }] })
      .expect(201);
    expect((await card([line({ prescriptionItemId: old.body.items[0].id })], 500, { customerId: customer.body.id })).body.message).toMatch(/older than 30 days/);
  });

  it('prescription medicines are never accepted from an offline till', async () => {
    const drug = await createProduct(tenantId, { name: 'Antibiotic', price: 500 });
    await ownerDb().product.update({ where: { id: drug.id }, data: { rxRequired: true } });
    const down = await till.call('GET', '/api/pos/sync/down').expect(200);
    const shift = await ownerDb().shift.findFirstOrThrow({ where: { registerId } });
    const payload = {
      id: uuidv7(), shiftId: shift.id, cashierId, receiptNo: 'P1-O000001', catalogVersion: down.body.cursor,
      lines: [{ productId: drug.id, qtyMilli: 1_000, unitPrice: 500, listPrice: 500, taxes: [] }],
      payments: [{ method: 'CASH', amount: 500 }], expectedTotal: 500, approvals: [],
    };
    const base = { kind: 'sale', seq: 1, prevHash: GENESIS, createdAt: new Date().toISOString(), payload } as unknown as OfflineOp;
    const hash = await opHash(base);
    const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, new TextEncoder().encode(hash))).toString('base64url');
    const res = await till.call('POST', '/api/pos/sync/up', { ops: [{ ...base, hash, sig }] }).expect(200);
    expect(res.body.results[0]).toMatchObject({ status: 'quarantined', reason: 'RX_NEEDS_ONLINE' });
  });
});
