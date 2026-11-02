import type { NestExpressApplication } from '@nestjs/platform-express';
import { PERMISSIONS } from '@pos/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { enrollTestDevice, signedHeaders } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('back-office', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;
  let owner: string;
  let ownerUserId: string;
  const asOwner = (r: request.Test) => r.set('Host', host).set(bearer(owner));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme', maxStores: 1 })).id;
    ownerUserId = (await createUser(tenantId, { email: 'owner@acme.lk', password: PW, permissions: [...PERMISSIONS] })).user.id;
    owner = await loginPassword(app, 'acme', 'owner@acme.lk', PW);
  });

  describe('stores and registers', () => {
    it('creates and lists, within the plan limit', async () => {
      const store = await asOwner(http().post('/api/stores')).send({ name: 'Colombo 03', code: 'COL3' }).expect(201);
      await asOwner(http().post('/api/stores')).send({ name: 'Kandy', code: 'KDY' }).expect(403);
      const reg = await asOwner(http().post('/api/registers')).send({ storeId: store.body.id, name: 'Till 1', code: 'T1' }).expect(201);
      expect(reg.body).toMatchObject({ storeId: store.body.id, code: 'T1' });
      expect((await asOwner(http().get('/api/stores')).expect(200)).body).toHaveLength(1);
      expect((await asOwner(http().get('/api/registers')).expect(200)).body).toHaveLength(1);
    });

    it('duplicate store codes conflict', async () => {
      await ownerDb().plan.updateMany({ data: { maxStores: 5 } });
      await asOwner(http().post('/api/stores')).send({ name: 'A', code: 'AAA' }).expect(201);
      await asOwner(http().post('/api/stores')).send({ name: 'B', code: 'AAA' }).expect(409);
    });

    it("refuses a register on another tenant's store", async () => {
      const other = await createTenant({ slug: 'other' });
      const foreign = await createStore(other.id);
      await asOwner(http().post('/api/registers')).send({ storeId: foreign.id, name: 'Till', code: 'T9' }).expect(404);
    });
  });

  describe('privilege escalation', () => {
    let manager: string;
    let cashierUserId: string;
    beforeEach(async () => {
      await createUser(tenantId, { email: 'mgr@acme.lk', password: PW, permissions: ['role.manage', 'user.manage', 'sale.create'] });
      manager = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
      cashierUserId = (await createUser(tenantId, { name: 'Cashier', permissions: ['sale.create'] })).user.id;
    });
    const asManager = (r: request.Test) => r.set('Host', host).set(bearer(manager));

    it('cannot create a role with a permission they lack', async () => {
      const res = await asManager(http().post('/api/roles')).send({ name: 'Refunder', permissions: ['sale.create', 'sale.refund'] }).expect(403);
      expect(res.body.details).toEqual({ missing: ['sale.refund'] });
      await asManager(http().post('/api/roles')).send({ name: 'Seller', permissions: ['sale.create'] }).expect(201);
    });

    it('cannot assign a role carrying a permission they lack', async () => {
      const refunder = await asOwner(http().post('/api/roles')).send({ name: 'Refunder', permissions: ['sale.refund'] }).expect(201);
      await asManager(http().post('/api/users')).send({ name: 'New', roleIds: [refunder.body.id], pin: '4321' }).expect(403);
    });

    it("cannot set the PIN of someone more privileged, can for someone they cover", async () => {
      await asManager(http().put(`/api/users/${ownerUserId}/pin`)).send({ pin: '1111' }).expect(403);
      await asManager(http().put(`/api/users/${cashierUserId}/pin`)).send({ pin: '1111' }).expect(204);
    });

    it('cannot create the reserved Owner role', async () => {
      await asOwner(http().post('/api/roles')).send({ name: 'owner', permissions: [] }).expect(400);
    });
  });

  describe('users', () => {
    it('creates a user with a one-time setup code and never exposes hashes', async () => {
      const role = await asOwner(http().post('/api/roles')).send({ name: 'Supervisor', permissions: ['sale.void'], requiresMfa: false }).expect(201);
      const created = await asOwner(http().post('/api/users')).send({ name: 'Nimal', email: 'Nimal@acme.lk', roleIds: [role.body.id], pin: '2468' }).expect(201);
      expect(created.body.setupCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(created.body.user).toEqual({ id: expect.any(String), name: 'Nimal', email: 'nimal@acme.lk', status: 'ACTIVE', roles: [{ id: role.body.id, name: 'Supervisor' }], hasPin: true });

      await http().post('/api/auth/setup-password').set('Host', host).send({ code: created.body.setupCode, password: PW }).expect(204);
      await loginPassword(app, 'acme', 'nimal@acme.lk', PW);

      const list = await asOwner(http().get('/api/users')).expect(200);
      const text = JSON.stringify(list.body);
      expect(text).not.toMatch(/argon2|Hash|totp/i);
      expect(list.body).toHaveLength(2);
    });

    it('refuses unknown role ids', async () => {
      await asOwner(http().post('/api/users')).send({ name: 'X', roleIds: ['0190b6a0-0000-7000-8000-000000000099'] }).expect(404);
    });

    it('serves the PIN pad to enrolled devices only', async () => {
      await createUser(tenantId, { name: 'With PIN', pin: '1357' });
      await createUser(tenantId, { name: 'No PIN' });
      const register = await createRegister(tenantId, (await createStore(tenantId)).id);
      const device = await enrollTestDevice(tenantId, register.id, ownerUserId);
      await http().get('/api/users/pin-pad').set('Host', host).expect(401);
      const res = await http().get('/api/users/pin-pad').set('Host', host).set(await signedHeaders(device, 'GET', '/api/users/pin-pad')).expect(200);
      expect(res.body.map((u: { name: string }) => u.name)).toEqual(['With PIN']);
    });
  });

  describe('audit view', () => {
    it('lists recent events and verifies the chain', async () => {
      await asOwner(http().post('/api/stores')).send({ name: 'Colombo 03', code: 'COL3' }).expect(201);
      const list = await asOwner(http().get('/api/audit?limit=10')).expect(200);
      expect(list.body[0]).toMatchObject({ action: 'store.created', seq: expect.stringMatching(/^\d+$/) });
      expect((await asOwner(http().get('/api/audit/verify')).expect(200)).body).toMatchObject({ ok: true });
    });

    it('requires audit.view', async () => {
      await createUser(tenantId, { email: 'c@acme.lk', password: PW, permissions: ['sale.create'] });
      const cashier = await loginPassword(app, 'acme', 'c@acme.lk', PW);
      await http().get('/api/audit').set('Host', host).set(bearer(cashier)).expect(403);
    });
  });
});
