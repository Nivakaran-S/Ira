import type { NestExpressApplication } from '@nestjs/platform-express';
import { PERMISSIONS } from '@pos/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { enrollTestDevice, signedHeaders, type TestDevice } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';
const LIST_ENDPOINTS = ['/api/stores', '/api/registers', '/api/users', '/api/roles', '/api/devices', '/api/audit'];

interface World {
  tenantId: string;
  token: string;
  storeId: string;
  registerId: string;
  roleId: string;
  userId: string;
  device: TestDevice;
  ids: Set<string>;
}

async function buildTenant(app: NestExpressApplication, slug: string): Promise<World> {
  const tenantId = (await createTenant({ slug, maxStores: 5 })).id;
  const owner = await createUser(tenantId, { email: `owner@${slug}.lk`, password: PW, permissions: [...PERMISSIONS] });
  const staff = await createUser(tenantId, { name: 'Staff', pin: '2468', permissions: ['sale.create'] });
  const store = await createStore(tenantId);
  const register = await createRegister(tenantId, store.id);
  const device = await enrollTestDevice(tenantId, register.id, owner.user.id);
  const token = await loginPassword(app, slug, `owner@${slug}.lk`, PW); // also writes an audit event
  const audit = await ownerDb().auditEvent.findMany({ where: { tenantId }, select: { id: true } });
  const ids = new Set([
    tenantId, owner.user.id, owner.role.id, staff.user.id, staff.role.id, store.id, register.id, device.id, ...audit.map((a) => a.id),
  ]);
  return { tenantId, token, storeId: store.id, registerId: register.id, roleId: staff.role.id, userId: staff.user.id, device, ids };
}

describe('cross-tenant isolation through the API', () => {
  let app: NestExpressApplication;
  let a: World;
  let b: World;
  const http = () => request(app.getHttpServer());
  const asA = (r: request.Test) => r.set('Host', hostFor('alpha')).set(bearer(a.token));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    a = await buildTenant(app, 'alpha');
    b = await buildTenant(app, 'bravo');
  });

  it.each(LIST_ENDPOINTS)('GET %s on A never returns B ids', async (path) => {
    const res = await asA(http().get(path)).expect(200);
    const text = JSON.stringify(res.body);
    for (const id of b.ids) expect(text).not.toContain(id);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it.each(LIST_ENDPOINTS)("A's token on B's host is refused for %s", async (path) => {
    const res = await http().get(path).set('Host', hostFor('bravo')).set(bearer(a.token)).expect(403);
    expect(res.body.code).toBe('TENANT_MISMATCH');
  });

  it('A cannot reference B rows in writes', async () => {
    await asA(http().post('/api/registers')).send({ storeId: b.storeId, name: 'x', code: 'X1' }).expect(404);
    await asA(http().post('/api/users')).send({ name: 'x', roleIds: [b.roleId] }).expect(404);
    await asA(http().post('/api/devices/enrollments')).send({ registerId: b.registerId }).expect(404);
  });

  it('A cannot modify B rows by id', async () => {
    await asA(http().post(`/api/devices/${b.device.id}/revoke`)).expect(404);
    await asA(http().put(`/api/users/${b.userId}/pin`)).send({ pin: '0000' }).expect(404);
    const device = await ownerDb().device.findUniqueOrThrow({ where: { id: b.device.id } });
    expect(device.revokedAt).toBeNull();
    const staff = await ownerDb().user.findUniqueOrThrow({ where: { id: b.userId } });
    expect(staff.pinFailedCount).toBe(0);
  });

  it("B's device cannot act on A's host", async () => {
    const path = '/api/users/pin-pad';
    await http().get(path).set('Host', hostFor('alpha')).set(await signedHeaders(b.device, 'GET', path)).expect(401);
  });

  it("A's audit chain and B's audit chain verify independently", async () => {
    expect((await asA(http().get('/api/audit/verify')).expect(200)).body).toMatchObject({ ok: true });
    const resB = await http().get('/api/audit/verify').set('Host', hostFor('bravo')).set(bearer(b.token)).expect(200);
    expect(resB.body).toMatchObject({ ok: true });
  });
});
