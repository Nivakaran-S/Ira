import { createHash, randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type OfflineOp, PERMISSIONS } from '@pos/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { enrollTestDevice, type TestDevice } from './helpers/device.js';
import { ADMIN_HOST, createRegister, createStore, createSuperAdmin, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword, loginSuperAdmin } from './helpers/http.js';
import { BILLING_GATEWAY } from '../src/modules/platform/payments/billing-gateway.js';
import { PayHereGateway } from '../src/modules/platform/payments/payhere-gateway.js';
import { Outbox } from './helpers/outbox.js';
import { flushRedis } from './helpers/redis.js';
import { createProduct, setSettings, TestTill } from './helpers/till.js';

const PW = 'correct horse battery staple';
const RETAIL = ['core', 'customers', 'loyalty'];
const card = { scheme: 'VISA', last4: '4242', authCode: '123456', terminalRef: 'term-0001' };

describe('offline shifts, voids, refunds and customers; terminal cards', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;
  let registerId: string;
  let cashierId: string;
  let managerId: string;
  let device: TestDevice;
  let till: TestTill;
  let owner: string;
  let teaId: string;
  let outbox: Outbox;
  let catalogVersion: string;
  const asOwner = (r: request.Test) => r.set('Host', host).set(bearer(owner));
  const push = async (...ops: OfflineOp[]) => (await till.call('POST', '/api/pos/sync/up', { ops }).expect(200)).body.results as { status: string; reason?: string }[];

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme', modules: RETAIL })).id;
    const storeId = (await createStore(tenantId)).id;
    registerId = (await createRegister(tenantId, storeId, { code: 'T1' })).id;
    cashierId = (await createUser(tenantId, { name: 'Cashier', pin: '1234', permissions: ['sale.create'] })).user.id;
    managerId = (await createUser(tenantId, { name: 'Manager', pin: '9876', permissions: ['sale.create', 'sale.refund', 'sale.void', 'shift.close', 'drawer.open'] })).user.id;
    await createUser(tenantId, { email: 'owner@acme.lk', password: PW, permissions: [...PERMISSIONS] });
    owner = await loginPassword(app, 'acme', 'owner@acme.lk', PW);
    device = await enrollTestDevice(tenantId, registerId, managerId);
    till = new TestTill(app, host, device);
    teaId = (await createProduct(tenantId, { name: 'Tea', price: 1_000 })).id;
    await setSettings(tenantId, { offline: { maxRefund: 10_000 }, loyalty: { earnSpend: 1_000, pointValue: 10, minRedeemPoints: 10 } });
    outbox = new Outbox(device);
    catalogVersion = (await till.call('GET', '/api/pos/sync/down').expect(200)).body.cursor;
  });

  const sale = (shiftId: string, n: number, over: Record<string, unknown> = {}) => ({
    id: uuidv7(), shiftId, cashierId, receiptNo: `T1-O${String(n).padStart(6, '0')}`, catalogVersion,
    lines: [{ id: uuidv7(), productId: teaId, qtyMilli: 2_000, unitPrice: 1_000, listPrice: 1_000, taxes: [] }],
    payments: [{ method: 'CASH', amount: 2_000, tendered: 2_000 }], expectedTotal: 2_000, approvals: [], ...over,
  });

  it('a whole shift offline: open, sell, refund an unsynced sale by its line id, void, close; resending changes nothing', async () => {
    const shiftId = uuidv7();
    const t0 = Date.now() - 10 * 60_000;
    const at = (min: number) => new Date(t0 + min * 60_000);
    const s1 = sale(shiftId, 1);
    const s2 = sale(shiftId, 2);
    const ops = [
      await outbox.op('shift_open', { id: shiftId, userId: cashierId, openingFloat: 5_000 }, at(0)),
      await outbox.op('sale', s1, at(1)),
      await outbox.op('sale', s2, at(2)),
      await outbox.op('refund', {
        id: uuidv7(), saleId: s1.id, shiftId, userId: cashierId, receiptNo: 'T1-O000003', lines: [{ saleLineId: s1.lines[0].id, qtyMilli: 1_000 }],
        method: 'CASH', reason: 'Spilled', restock: false, approvals: [{ action: 'sale.refund', approverId: managerId }],
      }, at(3)),
      await outbox.op('void', { id: uuidv7(), saleId: s2.id, userId: cashierId, reason: 'Wrong item', approvals: [{ action: 'sale.void', approverId: managerId }] }, at(4)),
      await outbox.op('shift_close', { id: uuidv7(), shiftId, userId: cashierId, countedCash: 5_900, note: 'Closed offline', approvals: [{ action: 'shift.close', approverId: managerId }] }, at(5)),
    ];
    expect((await push(...ops)).map((r) => r.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied', 'applied']);
    expect((await push(...ops)).map((r) => r.status)).toEqual(Array(6).fill('duplicate'));

    const shift = await ownerDb().shift.findUniqueOrThrow({ where: { id: shiftId } });
    // 5,000 float + 2,000 cash sale − 1,000 refund (the voided sale does not count) = 6,000 expected.
    expect(shift).toMatchObject({ status: 'CLOSED', openingFloat: 5_000, expectedCash: 6_000, countedCash: 5_900, variance: -100, openedAt: at(0), closedAt: at(5) });
    expect(await ownerDb().sale.findUniqueOrThrow({ where: { id: s2.id } })).toMatchObject({ status: 'VOIDED', voidedById: cashierId, voidReason: 'Wrong item' });
    const line = await ownerDb().saleLine.findUniqueOrThrow({ where: { id: s1.lines[0].id } });
    expect(line.refundedQtyMilli).toBe(1_000);
    const audit = await ownerDb().auditEvent.findMany({ where: { tenantId, action: { in: ['shift.opened', 'shift.closed', 'sale.voided'] } }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['shift.opened', 'sale.voided', 'shift.closed']);
  });

  it('offline voids and closes need the right approvals, and a closed shift takes no void', async () => {
    const shiftId = uuidv7();
    const s1 = sale(shiftId, 1);
    const res = await push(
      await outbox.op('shift_open', { id: shiftId, userId: cashierId, openingFloat: 0 }),
      await outbox.op('sale', s1),
      await outbox.op('void', { id: uuidv7(), saleId: s1.id, userId: cashierId, reason: 'Oops', approvals: [] }),
      await outbox.op('shift_close', { id: uuidv7(), shiftId, userId: cashierId, countedCash: 2_000, approvals: [] }),
      await outbox.op('shift_close', { id: uuidv7(), shiftId, userId: managerId, countedCash: 2_000, approvals: [] }),
      await outbox.op('void', { id: uuidv7(), saleId: s1.id, userId: managerId, reason: 'Late', approvals: [{ action: 'sale.void', approverId: managerId }] }),
    );
    expect(res.map((r) => r.reason ?? r.status)).toEqual(['applied', 'applied', 'APPROVAL_MISSING', 'APPROVAL_MISSING', 'applied', 'SHIFT_CLOSED']);
  });

  it('a shift opened offline while one is open on the server is held for review', async () => {
    await ownerDb().shift.create({ data: { tenantId, storeId: (await ownerDb().register.findUniqueOrThrow({ where: { id: registerId } })).storeId, registerId, openedById: cashierId, openingFloat: 0 } });
    const [r] = await push(await outbox.op('shift_open', { id: uuidv7(), userId: cashierId, openingFloat: 0 }));
    expect(r).toMatchObject({ status: 'quarantined', reason: 'CONFLICT' });
  });

  it('customers reach the till with balances; offline sales earn and spend; overdrawn spends are held, and a manager can accept them', async () => {
    const c = await asOwner(http().post('/api/customers')).send({ name: 'Kumari', phone: '0712345678' }).expect(201);
    await asOwner(http().post(`/api/customers/${c.body.id}/loyalty/adjust`)).send({ delta: 30, reason: 'Welcome gift' }).expect(201);
    const down = await till.call('GET', `/api/pos/sync/down?cursor=${catalogVersion}`).expect(200);
    expect(down.body.customers).toEqual([{ id: c.body.id, name: 'Kumari', phoneLast4: '5678', points: 30, credit: 0 }]);
    expect(JSON.stringify(down.body.customers)).not.toContain('0712345678');
    const cursor = down.body.cursor;
    expect((await till.call('GET', `/api/pos/sync/down?cursor=${cursor}`).expect(200)).body.customers).toEqual([]);

    const shiftId = uuidv7();
    // Two tills each spend 20 of the 30 points while offline; the second one overdraws.
    const spend = (n: number) => sale(shiftId, n, { customerId: c.body.id, payments: [{ method: 'LOYALTY', amount: 200 }, { method: 'CASH', amount: 1_800, tendered: 1_800 }] });
    const a = spend(1);
    const b = spend(2);
    const res = await push(await outbox.op('shift_open', { id: shiftId, userId: cashierId, openingFloat: 0 }), await outbox.op('sale', a), await outbox.op('sale', b));
    expect(res.map((r) => r.reason ?? r.status)).toEqual(['applied', 'applied', 'INVALID_STATE']);
    const balance = async () => (await ownerDb().loyaltyLedger.aggregate({ where: { customerId: c.body.id }, _sum: { delta: true } }))._sum.delta;
    expect(await balance()).toBe(30 - 20 + 1); // earned 1 point on the 1,800 paid in cash

    // The balance change reaches the tills.
    const after = await till.call('GET', `/api/pos/sync/down?cursor=${cursor}`).expect(200);
    expect(after.body.customers).toEqual([expect.objectContaining({ id: c.body.id, points: 11 })]);

    const [held] = (await asOwner(http().get('/api/sync/quarantine?status=PENDING')).expect(200)).body;
    await asOwner(http().post(`/api/sync/quarantine/${held.id}/accept`)).send({ note: 'Customer did get the goods' }).expect(200);
    expect(await balance()).toBe(11 - 20 + 1);
  });

  it('terminal-approved cards work offline even when keyed-in cards may not; card details are kept', async () => {
    const shiftId = uuidv7();
    const keyed = sale(shiftId, 2, { payments: [{ method: 'CARD', amount: 2_000 }] });
    const viaTerminal = sale(shiftId, 1, { payments: [{ method: 'CARD', amount: 2_000, reference: card.authCode, card }] });
    const res = await push(await outbox.op('shift_open', { id: shiftId, userId: cashierId, openingFloat: 0 }), await outbox.op('sale', viaTerminal), await outbox.op('sale', keyed));
    expect(res.map((r) => r.reason ?? r.status)).toEqual(['applied', 'applied', 'METHOD_NOT_ALLOWED_OFFLINE']);
    const pay = await ownerDb().payment.findFirstOrThrow({ where: { saleId: viaTerminal.id } });
    expect(pay.card).toEqual(card);

    // A card refund on the terminal keeps its result too.
    await push(await outbox.op('refund', {
      id: uuidv7(), saleId: viaTerminal.id, shiftId, userId: managerId, receiptNo: 'T1-O000003', lines: [{ saleLineId: viaTerminal.lines[0].id, qtyMilli: 2_000 }],
      method: 'CARD', reason: 'Returned', restock: true, card: { ...card, authCode: '654321', terminalRef: 'term-0002' }, approvals: [{ action: 'sale.refund', approverId: managerId }],
    }));
    expect((await ownerDb().refund.findFirstOrThrow({ where: { saleId: viaTerminal.id } })).card).toMatchObject({ terminalRef: 'term-0002' });
  });

  it('online sales keep the terminal result; malformed card details are refused', async () => {
    await till.login(cashierId, '1234');
    await till.openShift(0).expect(201);
    const s = await till.sell({ lines: [{ productId: teaId, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: 1_000, reference: card.authCode, card }], expectedTotal: 1_000 });
    expect(s.status).toBe(200);
    expect(s.body.payments[0].card).toEqual(card);
    const bad = await till.sell({ lines: [{ productId: teaId, qtyMilli: 1_000 }], payments: [{ method: 'CARD', amount: 1_000, card: { ...card, last4: '42' } }], expectedTotal: 1_000 });
    expect(bad.status).toBe(400);
  });
});

describe('online invoice payment (sandbox gateway)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('shop');
  let tenantId: string;
  let owner: string;
  let admin: string;
  const asOwner = (r: request.Test) => r.set('Host', host).set(bearer(owner));
  const asAdmin = (r: request.Test) => r.set('Host', ADMIN_HOST).set(bearer(admin));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'shop' })).id;
    await createUser(tenantId, { email: 'owner@shop.lk', password: PW, permissions: [...PERMISSIONS] });
    await createUser(tenantId, { email: 'clerk@shop.lk', password: PW, permissions: ['billing.view'] });
    owner = await loginPassword(app, 'shop', 'owner@shop.lk', PW);
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@platform.lk', password: PW, totpSecret: secret });
    admin = await loginSuperAdmin(app, 'root@platform.lk', PW, secret);
    await asAdmin(http().post('/api/platform/plans')).send({ key: 'pro', name: 'Pro', maxStores: 5, maxDevices: 5, maxUsers: 10, maxProducts: 100, priceMonthly: 1_500_000 }).expect(201);
    await asAdmin(http().put(`/api/platform/tenants/${tenantId}/plan`)).send({ planKey: 'pro' }).expect(200);
    await asAdmin(http().post('/api/platform/billing/run')).expect(200);
  });

  const due = async () => (await asOwner(http().get('/api/billing')).expect(200)).body.invoices[0];
  const session = (url: string) => /checkout\/(sbx_[0-9a-f]+)/.exec(url)![1];

  it('a suspended owner signs in, pays on the hosted page, and the business comes back', async () => {
    await ownerDb().invoice.updateMany({ data: { dueOn: new Date(Date.now() - 20 * 86_400_000) } });
    await asAdmin(http().post('/api/platform/billing/run')).expect(200);
    expect((await asOwner(http().get('/api/stores')).expect(403)).body.code).toBe('TENANT_SUSPENDED');

    // Signing in and the billing page still work while suspended for billing.
    owner = await loginPassword(app, 'shop', 'owner@shop.lk', PW);
    expect((await asOwner(http().get('/api/me')).expect(200)).body.tenant).toMatchObject({ status: 'SUSPENDED', suspendedReason: 'billing' });
    const billing = (await asOwner(http().get('/api/billing')).expect(200)).body;
    expect(billing).toMatchObject({ onlinePayment: true, suspendedForBilling: true });
    const inv = billing.invoices[0];

    const { url } = (await asOwner(http().post(`/api/billing/invoices/${inv.id}/checkout`)).expect(200)).body;
    expect(url).toMatch(/^\/api\/billing\/sandbox\/checkout\/sbx_/);
    const page = await http().get(url).set('Host', host).expect(200);
    expect(page.text).toContain('15,000.00');
    expect(page.text).toContain(inv.number);

    const paid = await http().post(`/api/billing/sandbox/checkout/${session(url)}/pay?return=/billing`).set('Host', host).type('form').send({ go: '1' }).expect(303);
    expect(paid.headers.location).toBe('/billing?payment=success');
    const after = (await asOwner(http().get('/api/billing')).expect(200)).body;
    expect(after.suspendedForBilling).toBe(false);
    expect(after.invoices[0]).toMatchObject({ status: 'PAID', lastPayment: { status: 'SUCCEEDED' } });
    expect(after.invoices[0].paidRef).toMatch(/^sandbox:sbx_pay_/);
    await asOwner(http().get('/api/stores')).expect(200);

    // Resending the outcome does nothing more.
    await http().post(`/api/billing/sandbox/checkout/${session(url)}/pay`).set('Host', host).type('form').send({}).expect(303);
    expect(await ownerDb().billingPayment.count({ where: { status: 'SUCCEEDED' } })).toBe(1);
  });

  it('a declined card leaves the invoice due; only billing.pay may start a checkout; webhooks need the signature', async () => {
    const inv = await due();
    const { url } = (await asOwner(http().post(`/api/billing/invoices/${inv.id}/checkout`)).expect(200)).body;
    const back = await http().post(`/api/billing/sandbox/checkout/${session(url)}/decline?return=//evil.example`).set('Host', host).type('form').send({}).expect(303);
    expect(back.headers.location).toBe('/billing?payment=failed');
    expect(await due()).toMatchObject({ status: 'DUE', lastPayment: { status: 'FAILED', failureReason: 'Card declined' } });

    const clerk = await loginPassword(app, 'shop', 'clerk@shop.lk', PW);
    await http().post(`/api/billing/invoices/${inv.id}/checkout`).set('Host', host).set(bearer(clerk)).expect(403);

    const forged = JSON.stringify({ sessionId: session(url), status: 'SUCCEEDED', amount: 1_500_000, currency: 'LKR' });
    await http().post('/api/platform/billing/webhooks/sandbox').set('Host', ADMIN_HOST).set('content-type', 'application/json').set('x-sandbox-signature', 'f'.repeat(64)).send(forged).expect(401);
    await http().post('/api/platform/billing/webhooks/stripe').set('Host', ADMIN_HOST).set('content-type', 'application/json').send(forged).expect(404);
    // Only the tenant's own invoices.
    const other = await createTenant({ slug: 'other' });
    await createUser(other.id, { email: 'o@other.lk', password: PW, permissions: [...PERMISSIONS] });
    const otherOwner = await loginPassword(app, 'other', 'o@other.lk', PW);
    await http().post(`/api/billing/invoices/${inv.id}/checkout`).set('Host', hostFor('other')).set(bearer(otherOwner)).expect(404);
  });
});

describe('online invoice payment (PayHere)', () => {
  const cfg = { merchantId: '1211149', merchantSecret: 'test-secret', sandbox: true, notifyUrl: 'https://api.example.lk/api/platform/billing/webhooks/payhere' };
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('shop');
  let owner: string;
  const MD5 = (s: string) => createHash('md5').update(s).digest('hex').toUpperCase();

  beforeAll(async () => {
    app = await createTestApp({ customize: (b) => b.overrideProvider(BILLING_GATEWAY).useValue(new PayHereGateway(cfg)) });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    const tenantId = (await createTenant({ slug: 'shop' })).id;
    await createUser(tenantId, { name: 'Nimal Owner', email: 'owner@shop.lk', password: PW, permissions: [...PERMISSIONS] });
    owner = await loginPassword(app, 'shop', 'owner@shop.lk', PW);
    const plan = await ownerDb().plan.create({ data: { key: 'pro', name: 'Pro', maxStores: 5, maxDevices: 5, maxUsers: 10, maxProducts: 100, priceMonthly: 1_500_000 } });
    await ownerDb().tenant.update({ where: { id: tenantId }, data: { planId: plan.id } });
    await ownerDb().invoice.create({
      data: { tenantId, number: 'INV-202611-shop', planKey: 'pro', periodStart: new Date('2026-11-01'), periodEnd: new Date('2026-11-30'), amount: 1_500_000, currency: 'LKR', dueOn: new Date('2026-11-08') },
    });
  });

  const notify = (orderId: string, statusCode: string, amount = '15000.00') => {
    const f = { merchant_id: cfg.merchantId, order_id: orderId, payment_id: '320025071278', payhere_amount: amount, payhere_currency: 'LKR', status_code: statusCode };
    const md5sig = MD5(f.merchant_id + f.order_id + f.payhere_amount + f.payhere_currency + f.status_code + MD5(cfg.merchantSecret));
    return http().post('/api/platform/billing/webhooks/payhere').set('Host', ADMIN_HOST).type('form').send({ ...f, md5sig });
  };

  it('hands the browser a signed PayHere form; a signed notification marks the invoice paid, once', async () => {
    const inv = (await http().get('/api/billing').set('Host', host).set(bearer(owner)).expect(200)).body.invoices[0];
    const co = (await http().post(`/api/billing/invoices/${inv.id}/checkout`).set('Host', host).set(bearer(owner)).expect(200)).body;
    expect(co.url).toBe('https://sandbox.payhere.lk/pay/checkout');
    expect(co.fields).toMatchObject({ merchant_id: '1211149', amount: '15000.00', currency: 'LKR', first_name: 'Nimal', email: 'owner@shop.lk', return_url: `http://${host}/billing?payment=submitted` });
    expect(JSON.stringify(co)).not.toContain('test-secret');

    await notify(co.fields.order_id, '0').expect(200);
    expect((await ownerDb().invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('DUE');
    await notify(co.fields.order_id, '2', '1.00').expect(200); // signed, but not what was asked for
    expect(await ownerDb().billingPayment.findFirstOrThrow({ where: { sessionId: co.fields.order_id } })).toMatchObject({ status: 'FAILED', failureReason: 'AMOUNT_MISMATCH' });

    const again = (await http().post(`/api/billing/invoices/${inv.id}/checkout`).set('Host', host).set(bearer(owner)).expect(200)).body;
    const forged = { merchant_id: cfg.merchantId, order_id: again.fields.order_id, payment_id: '1', payhere_amount: '15000.00', payhere_currency: 'LKR', status_code: '2', md5sig: 'F'.repeat(32) };
    await http().post('/api/platform/billing/webhooks/payhere').set('Host', ADMIN_HOST).type('form').send(forged).expect(401);
    await notify(again.fields.order_id, '2').expect(200);
    await notify(again.fields.order_id, '2').expect(200);
    const paid = await ownerDb().invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(paid).toMatchObject({ status: 'PAID', paidRef: 'payhere:320025071278' });
    expect(await ownerDb().billingPayment.count({ where: { status: 'SUCCEEDED' } })).toBe(1);
  });
});
