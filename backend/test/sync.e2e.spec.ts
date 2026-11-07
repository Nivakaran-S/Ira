import { webcrypto } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { GENESIS, type OfflineOp, opHash, PERMISSIONS, type TaxRateDef } from '@pos/shared';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { enrollTestDevice, type TestDevice } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';
import { createProduct, createSriLankaTaxes, setSettings, TestTill } from './helpers/till.js';

const PW = 'correct horse battery staple';

/** A till's offline outbox: builds hash-chained, device-signed ops. */
class Outbox {
  seq = 0;
  prev = GENESIS;
  constructor(private readonly device: TestDevice) {}

  async op(kind: OfflineOp['kind'], payload: unknown, createdAt = new Date(), tamper?: (o: OfflineOp) => void): Promise<OfflineOp> {
    const base = { kind, seq: ++this.seq, prevHash: this.prev, createdAt: createdAt.toISOString(), payload } as unknown as OfflineOp;
    const hash = await opHash(base);
    const sig = Buffer.from(
      await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.device.privateKey, new TextEncoder().encode(hash)),
    ).toString('base64url');
    this.prev = hash;
    const op = { ...base, hash, sig } as OfflineOp;
    tamper?.(op);
    return op;
  }
}

describe('offline sync', () => {
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
  let shiftId: string;
  let teaId: string;
  let taxes: TaxRateDef[];
  let outbox: Outbox;
  let catalogVersion: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme' })).id;
    storeId = (await createStore(tenantId)).id;
    registerId = (await createRegister(tenantId, storeId, { code: 'T1' })).id;
    cashierId = (await createUser(tenantId, { name: 'Cashier', pin: '1234', permissions: ['sale.create'] })).user.id;
    managerId = (await createUser(tenantId, { name: 'Manager', pin: '9876', permissions: ['sale.create', 'sale.refund', 'discount.apply', 'drawer.open'] })).user.id;
    device = await enrollTestDevice(tenantId, registerId, managerId);
    till = new TestTill(app, host, device);
    const { group, vat, sscl } = await createSriLankaTaxes(tenantId);
    taxes = [
      { id: vat.id, name: 'VAT', rateBp: 1800, compound: false },
      { id: sscl.id, name: 'SSCL', rateBp: 250, compound: false },
    ];
    teaId = (await createProduct(tenantId, { name: 'Tea', price: 1_000, taxGroupId: group.id })).id;
    shiftId = (await ownerDb().shift.create({ data: { tenantId, storeId, registerId, openedById: cashierId, openingFloat: 0 } })).id;
    outbox = new Outbox(device);
    catalogVersion = (await till.call('GET', '/api/pos/sync/down').expect(200)).body.cursor;
  });

  const sale = (over: Record<string, unknown> = {}) => ({
    id: uuidv7(), shiftId, cashierId, receiptNo: `T1-O${String(outbox.seq + 1).padStart(6, '0')}`, catalogVersion,
    lines: [{ productId: teaId, qtyMilli: 2_000, unitPrice: 1_000, listPrice: 1_000, taxes }],
    payments: [{ method: 'CASH', amount: 2_000, tendered: 2_000 }], expectedTotal: 2_000, approvals: [], ...over,
  });
  const push = (...ops: OfflineOp[]) => till.call('POST', '/api/pos/sync/up', { ops });

  describe('down', () => {
    it('sends the catalog, staff with permissions, and a receipt block; then only changes', async () => {
      const full = await till.call('GET', '/api/pos/sync/down').expect(200);
      expect(full.body).toMatchObject({
        full: true, currency: 'LKR', register: { code: 'T1' }, receiptBlock: { start: 1, end: 200 },
        settings: { offline: { enabled: true, maxHours: 24, maxRefund: 0 } },
      });
      expect(full.body.products).toEqual([expect.objectContaining({ id: teaId, price: 1_000, active: true })]);
      expect(full.body.taxGroups[0].rates.map((r: TaxRateDef) => r.name)).toEqual(['VAT', 'SSCL']);
      expect(full.body.users.map((u: { name: string }) => u.name)).toEqual(['Cashier', 'Manager']);
      expect(full.body.users[1].permissions).toContain('sale.refund');
      expect(JSON.stringify(full.body)).not.toMatch(/pinHash|argon2/);

      const cursor = full.body.cursor;
      const none = await till.call('GET', `/api/pos/sync/down?cursor=${cursor}&blockNext=1`).expect(200);
      expect(none.body).toMatchObject({ full: false, products: [], taxGroups: [], categories: [], cursor, receiptBlock: { start: 1, end: 200 } });

      await ownerDb().product.update({ where: { id: teaId }, data: { price: 1_200 } });
      await ownerDb().taxRate.updateMany({ where: { name: 'VAT' }, data: { rateBp: 1500 } });
      const delta = await till.call('GET', `/api/pos/sync/down?cursor=${cursor}`).expect(200);
      expect(delta.body.products).toEqual([expect.objectContaining({ id: teaId, price: 1_200 })]);
      expect(delta.body.taxGroups[0].rates[0]).toMatchObject({ name: 'VAT', rateBp: 1500 });
      expect(BigInt(delta.body.cursor)).toBeGreaterThan(BigInt(cursor));

      // A nearly used-up block is replaced by a fresh one from the register's offline counter.
      const refill = await till.call('GET', `/api/pos/sync/down?cursor=${delta.body.cursor}&blockNext=180`).expect(200);
      expect(refill.body.receiptBlock).toEqual({ start: 201, end: 400 });
    });

    it('needs a device signature, and a revoked device is cut off', async () => {
      await http().get('/api/pos/sync/down').set('Host', host).expect(401);
      await ownerDb().device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
      const res = await till.call('GET', '/api/pos/sync/down');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('DEVICE_REVOKED');
    });
  });

  describe('up', () => {
    it('applies a chained sale, refund and pay-out once; resending is harmless', async () => {
      await setSettings(tenantId, { offline: { maxRefund: 5_000 } });
      const s = sale();
      const at = new Date(Date.now() - 60_000);
      const ops = [
        await outbox.op('sale', s, at),
        await outbox.op('refund', {
          id: uuidv7(), saleId: s.id, shiftId, userId: managerId, receiptNo: 'T1-O000002', lines: [{ saleLineId: '00000000-0000-7000-8000-000000000000', qtyMilli: 1_000 }],
          method: 'CASH', reason: 'Spilled', restock: true, approvals: [],
        }),
      ];
      // The refund needs the real sale line id, which the till knows: fix it up and re-sign from the second op.
      const line = await (async () => {
        const res = await push(ops[0]);
        expect(res.body.results).toEqual([{ id: s.id, seq: 1, status: 'applied' }]);
        return (await ownerDb().saleLine.findFirstOrThrow({ where: { saleId: s.id } })).id;
      })();
      outbox.seq = 1;
      outbox.prev = ops[0].hash;
      const refund = await outbox.op('refund', {
        id: uuidv7(), saleId: s.id, shiftId, userId: managerId, receiptNo: 'T1-O000002', lines: [{ saleLineId: line, qtyMilli: 1_000 }],
        method: 'CASH', reason: 'Spilled', restock: true, approvals: [{ action: 'sale.refund', approverId: managerId }],
      });
      const cash = await outbox.op('cash', { id: uuidv7(), shiftId, userId: managerId, type: 'PAY_OUT', amount: 300, reason: 'Milk', approvals: [] });
      const res = await push(ops[0], refund, cash).expect(200);
      expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['duplicate', 'applied', 'applied']);

      const stored = await ownerDb().sale.findUniqueOrThrow({ where: { id: s.id } });
      expect(stored).toMatchObject({ offline: true, receiptNo: 'T1-O000001', due: 2_000, cashierId });
      expect(stored.soldAt.toISOString()).toBe(at.toISOString());
      expect((await ownerDb().refund.findFirstOrThrow()).offline).toBe(true);
      const level = await ownerDb().stockLevel.findFirstOrThrow({ where: { productId: teaId } });
      expect(level.qtyMilli).toBe(-1_000);
      const report = await till.login(cashierId, '1234').then((t) => t.call('GET', '/api/pos/shift').expect(200));
      expect(report.body.shift.cash).toMatchObject({ sales: 2_000, refunds: 1_000, payOuts: 300, expected: 700 });
      expect((await push(refund, cash).expect(200)).body.results.map((r: { status: string }) => r.status)).toEqual(['duplicate', 'duplicate']);
    });

    it('quarantines a forged op without moving the chain; the next genuine op still applies', async () => {
      const forged = await outbox.op('sale', sale(), new Date(), (o) => {
        (o.payload as { expectedTotal: number }).expectedTotal = 1;
      });
      outbox.seq = 0;
      outbox.prev = GENESIS;
      const real = await outbox.op('sale', sale());
      const res = await push(forged).expect(200);
      expect(res.body.results[0]).toMatchObject({ status: 'quarantined', reason: 'BAD_SIGNATURE' });
      expect((await push(real).expect(200)).body.results[0].status).toBe('applied');
    });

    it('a gap in the chain is quarantined and the chain carries on from it', async () => {
      await outbox.op('sale', sale()); // lost: never pushed
      const second = await outbox.op('sale', sale());
      const third = await outbox.op('sale', sale());
      const res = await push(second, third).expect(200);
      expect(res.body.results.map((r: { status: string; reason?: string }) => r.reason ?? r.status)).toEqual(['CHAIN_GAP', 'applied']);
      expect(await ownerDb().syncQuarantine.count({ where: { reason: 'CHAIN_GAP' } })).toBe(1);
    });

    it('checks totals, known prices, card use and approvals', async () => {
      const results = async (...payloads: Record<string, unknown>[]) => {
        const ops = [];
        for (const p of payloads) ops.push(await outbox.op('sale', p));
        return (await push(...ops).expect(200)).body.results.map((r: { status: string; reason?: string }) => r.reason ?? r.status);
      };
      expect(
        await results(
          sale({ expectedTotal: 1_900, payments: [{ method: 'CASH', amount: 1_900 }] }),
          sale({ lines: [{ productId: teaId, qtyMilli: 1_000, unitPrice: 500, listPrice: 500, taxes }], expectedTotal: 500, payments: [{ method: 'CASH', amount: 500 }] }),
          sale({ payments: [{ method: 'CARD', amount: 2_000 }] }),
          sale({ lines: [{ productId: teaId, qtyMilli: 2_000, unitPrice: 1_000, listPrice: 1_000, taxes, discount: { kind: 'percent', bp: 500 } }], expectedTotal: 1_900, payments: [{ method: 'CASH', amount: 1_900 }] }),
          sale({
            lines: [{ productId: teaId, qtyMilli: 2_000, unitPrice: 1_000, listPrice: 1_000, taxes, discount: { kind: 'percent', bp: 500 } }], expectedTotal: 1_900,
            payments: [{ method: 'CASH', amount: 1_900 }], approvals: [{ action: 'discount.apply', approverId: managerId }],
          }),
          sale({
            lines: [{ productId: teaId, qtyMilli: 2_000, unitPrice: 1_000, listPrice: 1_000, taxes, discount: { kind: 'percent', bp: 500 } }], expectedTotal: 1_900,
            payments: [{ method: 'CASH', amount: 1_900 }], approvals: [{ action: 'discount.apply', approverId: cashierId }],
          }),
        ),
      ).toEqual(['TOTAL_MISMATCH', 'PRICE_MISMATCH', 'METHOD_NOT_ALLOWED_OFFLINE', 'APPROVAL_MISSING', 'applied', 'APPROVER_NOT_ALLOWED']);
    });

    it('accepts the price the till had when the catalog changed after its snapshot', async () => {
      await ownerDb().product.update({ where: { id: teaId }, data: { price: 1_500 } });
      const res = await push(await outbox.op('sale', sale())).expect(200);
      expect(res.body.results[0].status).toBe('applied');
    });

    it('enforces the offline window; a manager can accept or reject quarantined items', async () => {
      await createUser(tenantId, { email: 'owner@acme.lk', password: PW, permissions: [...PERMISSIONS] });
      const owner = await loginPassword(app, 'acme', 'owner@acme.lk', PW);
      const asOwner = (r: request.Test) => r.set('Host', host).set(bearer(owner));
      await ownerDb().syncCursor.update({ where: { deviceId: device.id }, data: { lastContactAt: new Date(Date.now() - 30 * 3_600_000) } });

      const late = await outbox.op('sale', sale(), new Date(Date.now() - 60_000));
      const wrong = await outbox.op('sale', sale({ expectedTotal: 5, payments: [{ method: 'CASH', amount: 5 }] }), new Date(Date.now() - 60_000));
      const res = await push(late, wrong).expect(200);
      expect(res.body.results.map((r: { reason: string }) => r.reason)).toEqual(['OUTSIDE_OFFLINE_WINDOW', 'OUTSIDE_OFFLINE_WINDOW']);

      const list = (await asOwner(http().get('/api/sync/quarantine?status=PENDING')).expect(200)).body;
      expect(list).toHaveLength(2);
      expect((await asOwner(http().get('/api/sync/quarantine/count')).expect(200)).body).toEqual({ pending: 2 });
      const byOp = (id: string) => list.find((q: { opId: string }) => q.opId === id).id;

      await asOwner(http().post(`/api/sync/quarantine/${byOp(late.payload.id)}/accept`)).send({ note: 'Power cut, verified' }).expect(200);
      expect((await ownerDb().sale.findUniqueOrThrow({ where: { id: late.payload.id } })).offline).toBe(true);
      // Arithmetic is never waived: the wrong total can only be rejected.
      const bad = await asOwner(http().post(`/api/sync/quarantine/${byOp(wrong.payload.id)}/accept`)).send({ note: 'try' }).expect(409);
      expect(bad.body.details.reason).toBe('TOTAL_MISMATCH');
      await asOwner(http().post(`/api/sync/quarantine/${byOp(wrong.payload.id)}/reject`)).send({ note: 'Cashier error, cash counted' }).expect(200);
      expect((await asOwner(http().get('/api/sync/quarantine/count')).expect(200)).body).toEqual({ pending: 0 });
      expect(await ownerDb().auditEvent.count({ where: { tenantId, action: { in: ['sync.quarantine_accepted', 'sync.quarantine_rejected'] } } })).toBe(2);

      // Cashiers cannot review.
      await createUser(tenantId, { email: 'c@acme.lk', password: PW, permissions: ['sale.create'] });
      const c = await loginPassword(app, 'acme', 'c@acme.lk', PW);
      await http().get('/api/sync/quarantine').set('Host', host).set(bearer(c)).expect(403);
    });
  });
});
