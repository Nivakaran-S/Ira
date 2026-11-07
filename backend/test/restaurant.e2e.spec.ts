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
import { createProduct, TestTill } from './helpers/till.js';

const PW = 'correct horse battery staple';
const CAFE = ['core', 'customers', 'tables', 'modifiers', 'kitchen-display', 'split-bill'];

describe('restaurant modules', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('cafe');
  let tenantId: string;
  let storeId: string;
  let managerId: string;
  let till: TestTill;
  let kitchen: TestTill;
  let owner: string;
  let latteId: string;
  let teaId: string;
  let sizeLarge: string;
  let sizeSmall: string;
  let shot: string;
  const asOwner = (r: request.Test) => r.set('Host', host).set(bearer(owner));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'cafe', modules: CAFE })).id;
    storeId = (await createStore(tenantId)).id;
    const registerId = (await createRegister(tenantId, storeId, { code: 'T1' })).id;
    const kitchenRegister = (await createRegister(tenantId, storeId, { code: 'K1' })).id;
    const cashierId = (await createUser(tenantId, { name: 'Waiter', pin: '1234', permissions: ['sale.create'] })).user.id;
    managerId = (await createUser(tenantId, { name: 'Manager', pin: '9876', permissions: ['sale.create', 'sale.void'] })).user.id;
    const cookId = (await createUser(tenantId, { name: 'Cook', pin: '5555', permissions: ['kitchen.view'] })).user.id;
    await createUser(tenantId, { email: 'owner@cafe.lk', password: PW, permissions: [...PERMISSIONS] });
    owner = await loginPassword(app, 'cafe', 'owner@cafe.lk', PW);
    till = await new TestTill(app, host, await enrollTestDevice(tenantId, registerId, managerId)).login(cashierId, '1234');
    kitchen = await new TestTill(app, host, await enrollTestDevice(tenantId, kitchenRegister, managerId)).login(cookId, '5555');
    await till.openShift(0).expect(201);

    latteId = (await createProduct(tenantId, { name: 'Latte', price: 500 })).id;
    teaId = (await createProduct(tenantId, { name: 'Tea', price: 300 })).id;
    const size = await asOwner(http().post('/api/modifier-groups'))
      .send({ name: 'Size', minSelect: 1, maxSelect: 1, options: [{ name: 'Small' }, { name: 'Large', priceDelta: 150 }] })
      .expect(201);
    const extras = await asOwner(http().post('/api/modifier-groups'))
      .send({ name: 'Extras', minSelect: 0, maxSelect: 2, options: [{ name: 'Extra shot', priceDelta: 100 }, { name: 'Oat milk', priceDelta: 80 }] })
      .expect(201);
    [sizeSmall, sizeLarge] = size.body.options.map((o: { id: string }) => o.id);
    shot = extras.body.options[0].id;
    await asOwner(http().put(`/api/products/${latteId}/modifier-groups`)).send({ groupIds: [size.body.id, extras.body.id] }).expect(200);
  });

  it('modifiers: required choices, prices with deltas, and on the receipt', async () => {
    const missing = await till.sell({ lines: [{ productId: latteId, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: 500 }], expectedTotal: 500 });
    expect(missing.body).toMatchObject({ code: 'INVALID_STATE', message: 'Latte: Choose 1 for Size' });
    const ok = await till.sell({ lines: [{ productId: latteId, qtyMilli: 2_000, modifierIds: [sizeLarge, shot] }], payments: [{ method: 'CARD', amount: 1_500 }], expectedTotal: 1_500 });
    expect(ok.status).toBe(200);
    expect(ok.body.lines[0]).toMatchObject({ unitPrice: 750, listPrice: 750, modifiers: [{ name: 'Large', priceDelta: 150 }, { name: 'Extra shot', priceDelta: 100 }] });
    const receipt = await till.call('GET', `/api/pos/sales/${ok.body.id}/receipt`).expect(200);
    expect(receipt.body.lines[0].note).toBe('Large, Extra shot');
    const down = await till.call('GET', '/api/pos/sync/down').expect(200);
    expect(down.body.modifierGroups.map((g: { name: string }) => g.name).sort()).toEqual(['Extras', 'Size']);
    expect(down.body.products.find((p: { id: string }) => p.id === latteId).modifierGroupIds).toHaveLength(2);
  });

  it('a table order: add, send to the kitchen, bump, void with approval, split the bill with a tip, close', async () => {
    const table = await asOwner(http().post('/api/tables')).send({ storeId, name: 'T5', area: 'Patio', seats: 4 }).expect(201);
    const orderId = uuidv7();
    await till.call('POST', '/api/pos/orders', { id: orderId, tableId: table.body.id, guests: 2 }).expect(201);
    expect((await till.call('POST', '/api/pos/orders', { id: uuidv7(), tableId: table.body.id })).status).toBe(409);

    const latteLine = uuidv7();
    const teaLine = uuidv7();
    const extraTea = uuidv7();
    await till.call('POST', `/api/pos/orders/${orderId}/lines`, {
      lines: [
        { id: latteLine, productId: latteId, qtyMilli: 2_000, modifierIds: [sizeSmall] },
        { id: teaLine, productId: teaId, qtyMilli: 1_000, note: 'No sugar' },
        { id: extraTea, productId: teaId, qtyMilli: 1_000 },
      ],
    }).expect(200);
    const floor = await till.call('GET', '/api/pos/floor').expect(200);
    expect(floor.body.tables[0]).toMatchObject({ name: 'T5', order: { total: 1_600, unsent: 3 } });

    await till.call('POST', `/api/pos/orders/${orderId}/send`).expect(200);
    const tickets = await kitchen.call('GET', '/api/pos/kitchen').expect(200);
    expect(tickets.body[0]).toMatchObject({ table: 'T5', lines: [expect.objectContaining({ name: 'Latte', status: 'SENT' }), expect.anything(), expect.anything()] });
    await kitchen.call('POST', `/api/pos/kitchen/lines/${latteLine}`, { status: 'READY' }).expect(200);
    await till.call('GET', '/api/pos/kitchen').expect(403); // waiters do not hold kitchen.view

    // The extra tea was sent by mistake: voiding it needs the manager.
    const denied = await till.call('DELETE', `/api/pos/orders/${orderId}/lines/${extraTea}`);
    expect(denied.body.code).toBe('STEP_UP_REQUIRED');
    const voided = await till.call('DELETE', `/api/pos/orders/${orderId}/lines/${extraTea}`, undefined, { 'x-step-up-token': await till.stepUp(managerId, '9876', 'sale.void') });
    expect(voided.status).toBe(200);
    expect(voided.body.lines.find((l: { id: string }) => l.id === extraTea).status).toBe('VOID');

    // Guest one pays for one latte by card with a 100 tip; guest two pays the rest in cash.
    const one = await till.call('POST', `/api/pos/orders/${orderId}/pay`, {
      saleId: uuidv7(), lines: [{ orderLineId: latteLine, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: 600 }], tip: 100, expectedTotal: 500,
    }).expect(200);
    expect(one.body).toMatchObject({ due: 500, tip: 100, orderId });
    expect((await till.call('GET', `/api/pos/orders/${orderId}`).expect(200)).body.status).toBe('OPEN');
    await till.call('POST', `/api/pos/orders/${orderId}/pay`, {
      saleId: uuidv7(), lines: [{ orderLineId: latteLine, qtyMilli: 2_000 }], payments: [{ method: 'CASH', amount: 1_000 }], expectedTotal: 1_000,
    }).expect(409); // only one latte is left
    const two = await till.call('POST', `/api/pos/orders/${orderId}/pay`, {
      saleId: uuidv7(), lines: [{ orderLineId: latteLine, qtyMilli: 1_000 }, { orderLineId: teaLine, qtyMilli: 1_000 }],
      payments: [{ method: 'CASH', amount: 800, tendered: 1_000 }], expectedTotal: 800,
    }).expect(200);
    expect(two.body.lines[1].note).toBe('No sugar');
    expect((await till.call('GET', `/api/pos/orders/${orderId}`).expect(200)).body.status).toBe('CLOSED');
    expect((await till.call('GET', '/api/pos/floor').expect(200)).body.tables[0].order).toBeNull();

    const shift = await till.call('GET', '/api/pos/shift').expect(200);
    expect(shift.body.shift.sales).toMatchObject({ count: 2, total: 1_300, tips: 100 });
    const receipt = await till.call('GET', `/api/pos/sales/${one.body.id}/receipt`).expect(200);
    expect(receipt.body.totals).toContainEqual({ label: 'Tip', value: '1.00' });
  });

  it('a counter tab needs a name; cancelling a tab with sent items needs a manager', async () => {
    expect((await till.call('POST', '/api/pos/orders', { id: uuidv7() })).status).toBe(400);
    const id = uuidv7();
    await till.call('POST', '/api/pos/orders', { id, name: 'Nimal' }).expect(201);
    await till.call('POST', `/api/pos/orders/${id}/lines`, { lines: [{ id: uuidv7(), productId: teaId, qtyMilli: 1_000 }] }).expect(200);
    await till.call('POST', `/api/pos/orders/${id}/send`).expect(200);
    expect((await till.call('POST', `/api/pos/orders/${id}/cancel`)).body.code).toBe('STEP_UP_REQUIRED');
    await till.call('POST', `/api/pos/orders/${id}/cancel`, undefined, { 'x-step-up-token': await till.stepUp(managerId, '9876', 'sale.void') }).expect(200);
    expect((await till.call('GET', '/api/pos/floor').expect(200)).body.tabs).toEqual([]);
  });

  it('tables and tips are refused without the tables module', async () => {
    await ownerDb().tenantModule.create({ data: { tenantId, moduleKey: 'tables', enabled: false } });
    await flushRedis();
    await till.login((await ownerDb().user.findFirstOrThrow({ where: { name: 'Waiter' } })).id, '1234');
    expect((await till.call('GET', '/api/pos/floor')).body.code).toBe('MODULE_DISABLED');
    const tip = await till.sell({ lines: [{ productId: teaId, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: 400 }], tip: 100, expectedTotal: 300 });
    expect(tip.body.code).toBe('MODULE_DISABLED');
  });
});
