import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { createDeviceKeys, enrollTestDevice, signedHeaders } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';
const WHOAMI = '/api/devices/whoami';

describe('devices', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;
  let registerId: string;
  let managerId: string;
  let managerToken: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme', maxDevices: 2 })).id;
    const store = await createStore(tenantId);
    registerId = (await createRegister(tenantId, store.id)).id;
    managerId = (await createUser(tenantId, { email: 'mgr@acme.lk', password: PW, permissions: ['device.enroll', 'device.revoke'] })).user.id;
    managerToken = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
  });

  async function enrollViaApi() {
    const created = await http().post('/api/devices/enrollments').set('Host', host).set(bearer(managerToken)).send({ registerId }).expect(201);
    expect(created.body.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const keys = await createDeviceKeys();
    const enrolled = await http()
      .post('/api/devices/enroll')
      .set('Host', host)
      .send({ code: created.body.code, name: 'Front till', publicKeyJwk: keys.publicKeyJwk })
      .expect(201);
    return { code: created.body.code as string, device: { id: enrolled.body.deviceId as string, ...keys } };
  }

  it('enrols a device with a one-time code, then accepts its signed requests', async () => {
    const { device } = await enrollViaApi();
    const res = await http().get(WHOAMI).set('Host', host).set(await signedHeaders(device, 'GET', WHOAMI)).expect(200);
    expect(res.body).toEqual({ id: device.id, registerId });
    expect(await ownerDb().auditEvent.count({ where: { action: 'device.enrolled' } })).toBe(1);
  });

  it('enrollment codes are single use', async () => {
    const { code } = await enrollViaApi();
    const keys = await createDeviceKeys();
    await http().post('/api/devices/enroll').set('Host', host).send({ code, name: 'Second', publicKeyJwk: keys.publicKeyJwk }).expect(401);
  });

  it('expired enrollment codes are refused', async () => {
    const created = await http().post('/api/devices/enrollments').set('Host', host).set(bearer(managerToken)).send({ registerId }).expect(201);
    await ownerDb().deviceEnrollment.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const keys = await createDeviceKeys();
    await http().post('/api/devices/enroll').set('Host', host).send({ code: created.body.code, name: 'x', publicKeyJwk: keys.publicKeyJwk }).expect(401);
  });

  it('rejects a public key that is not a valid P-256 point', async () => {
    const created = await http().post('/api/devices/enrollments').set('Host', host).set(bearer(managerToken)).send({ registerId }).expect(201);
    const bogus = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
    const res = await http().post('/api/devices/enroll').set('Host', host).send({ code: created.body.code, name: 'x', publicKeyJwk: bogus }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an enrollment for a register that does not exist in this tenant', async () => {
    const other = await createTenant({ slug: 'other' });
    const otherRegister = await createRegister(other.id, (await createStore(other.id)).id);
    await http().post('/api/devices/enrollments').set('Host', host).set(bearer(managerToken)).send({ registerId: otherRegister.id }).expect(404);
  });

  it('enforces the plan device limit', async () => {
    await enrollTestDevice(tenantId, registerId, managerId);
    await enrollTestDevice(tenantId, registerId, managerId);
    const res = await http().post('/api/devices/enrollments').set('Host', host).set(bearer(managerToken)).send({ registerId }).expect(403);
    expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
  });

  describe('signature verification', () => {
    it('refuses unsigned requests', async () => {
      const res = await http().get(WHOAMI).set('Host', host).expect(401);
      expect(res.body.code).toBe('DEVICE_SIGNATURE_INVALID');
    });

    it('refuses a signature made for a different path', async () => {
      const device = await enrollTestDevice(tenantId, registerId, managerId);
      await http().get(`${WHOAMI}?x=1`).set('Host', host).set(await signedHeaders(device, 'GET', WHOAMI)).expect(401);
    });

    it('refuses a replayed nonce', async () => {
      const device = await enrollTestDevice(tenantId, registerId, managerId);
      const headers = await signedHeaders(device, 'GET', WHOAMI);
      await http().get(WHOAMI).set('Host', host).set(headers).expect(200);
      await http().get(WHOAMI).set('Host', host).set(headers).expect(401);
    });

    it('refuses stale timestamps', async () => {
      const device = await enrollTestDevice(tenantId, registerId, managerId);
      const headers = await signedHeaders(device, 'GET', WHOAMI, undefined, { ts: Math.floor(Date.now() / 1000) - 300 });
      await http().get(WHOAMI).set('Host', host).set(headers).expect(401);
    });

    it('refuses a signature from another key', async () => {
      const device = await enrollTestDevice(tenantId, registerId, managerId);
      const impostor = await createDeviceKeys();
      await http().get(WHOAMI).set('Host', host).set(await signedHeaders({ id: device.id, privateKey: impostor.privateKey }, 'GET', WHOAMI)).expect(401);
    });

    it("refuses another tenant's device", async () => {
      await createTenant({ slug: 'other' });
      const device = await enrollTestDevice(tenantId, registerId, managerId);
      await http().get(WHOAMI).set('Host', hostFor('other')).set(await signedHeaders(device, 'GET', WHOAMI)).expect(401);
    });
  });

  it('a revoked device is refused immediately', async () => {
    const device = await enrollTestDevice(tenantId, registerId, managerId);
    await http().post(`/api/devices/${device.id}/revoke`).set('Host', host).set(bearer(managerToken)).expect(204);
    const res = await http().get(WHOAMI).set('Host', host).set(await signedHeaders(device, 'GET', WHOAMI)).expect(401);
    expect(res.body.code).toBe('DEVICE_REVOKED');
  });

  it('lists devices for managers', async () => {
    const device = await enrollTestDevice(tenantId, registerId, managerId);
    const res = await http().get('/api/devices').set('Host', host).set(bearer(managerToken)).expect(200);
    expect(res.body).toEqual([expect.objectContaining({ id: device.id, registerId, revokedAt: null })]);
    expect(res.body[0].publicKeyJwk).toBeUndefined();
  });
});
