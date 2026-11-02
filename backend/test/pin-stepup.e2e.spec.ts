import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { resetDb } from './helpers/db.js';
import { enrollTestDevice, signedHeaders, type TestDevice } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword, refreshCookie } from './helpers/http.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('PIN login and step-up', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;
  let registerId: string;
  let cashierId: string;
  let managerId: string;
  let device: TestDevice;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme' })).id;
    registerId = (await createRegister(tenantId, (await createStore(tenantId)).id)).id;
    cashierId = (await createUser(tenantId, { name: 'Cashier', pin: '1234', permissions: ['sale.create'] })).user.id;
    managerId = (
      await createUser(tenantId, {
        name: 'Manager', email: 'mgr@acme.lk', password: PW, pin: '9876',
        permissions: ['sale.create', 'sale.refund', 'device.revoke'],
      })
    ).user.id;
    device = await enrollTestDevice(tenantId, registerId, managerId);
  });

  async function pinLogin(userId = cashierId, pin = '1234', d: TestDevice = device) {
    const body = { userId, pin };
    return http().post('/api/auth/pin').set('Host', host).set(await signedHeaders(d, 'POST', '/api/auth/pin', body)).send(body);
  }

  async function deviceSale(token: string, d: TestDevice = device) {
    return http().post('/api/probe/device-sale').set('Host', host).set(bearer(token)).set(await signedHeaders(d, 'POST', '/api/probe/device-sale'));
  }

  it('logs a cashier in with a PIN on an enrolled device; the session is device-bound', async () => {
    const res = await pinLogin();
    expect(res.status).toBe(200);
    const ok = await deviceSale(res.body.accessToken);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ device: { id: device.id, registerId }, principal: { userId: cashierId, deviceId: device.id } });
    // Same token without a signature, or signed by another device, is refused.
    await http().post('/api/probe/device-sale').set('Host', host).set(bearer(res.body.accessToken)).expect(401);
    const other = await enrollTestDevice(tenantId, registerId, managerId);
    expect((await deviceSale(res.body.accessToken, other)).status).toBe(401);
  });

  it('refuses PIN login without a device signature', async () => {
    const res = await http().post('/api/auth/pin').set('Host', host).send({ userId: cashierId, pin: '1234' }).expect(401);
    expect(res.body.code).toBe('DEVICE_SIGNATURE_INVALID');
  });

  it('locks PIN login after 5 wrong PINs', async () => {
    for (let i = 0; i < 5; i++) expect((await pinLogin(cashierId, '0000')).status).toBe(401);
    const res = await pinLogin();
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('device-bound refresh requires the same device', async () => {
    const login = await pinLogin();
    const rt = refreshCookie(login)!;
    await http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt}`).expect(401);
    const login2 = await pinLogin();
    const rt2 = refreshCookie(login2)!;
    await http()
      .post('/api/auth/refresh')
      .set('Host', host)
      .set('Cookie', `pos_rt=${rt2}`)
      .set(await signedHeaders(device, 'POST', '/api/auth/refresh'))
      .expect(200);
  });

  it('revoking the device ends its sessions', async () => {
    const login = await pinLogin();
    const mgrToken = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
    await http().post(`/api/devices/${device.id}/revoke`).set('Host', host).set(bearer(mgrToken)).expect(204);
    const res = await deviceSale(login.body.accessToken);
    expect(res.status).toBe(401);
  });

  describe('step-up', () => {
    async function refund(token: string, stepUpToken?: string) {
      const req = http().post('/api/probe/refund').set('Host', host).set(bearer(token)).set(await signedHeaders(device, 'POST', '/api/probe/refund'));
      return stepUpToken ? req.set('x-step-up-token', stepUpToken) : req;
    }
    async function approve(token: string, approverUserId: string, pin: string, action = 'sale.refund', d: TestDevice = device) {
      const body = { approverUserId, pin, action };
      return http().post('/api/auth/step-up').set('Host', host).set(bearer(token)).set(await signedHeaders(d, 'POST', '/api/auth/step-up', body)).send(body);
    }

    it('requires a manager approval for the action, usable once', async () => {
      const cashier = (await pinLogin()).body.accessToken as string;
      const denied = await refund(cashier);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { action: 'sale.refund' } });

      const granted = await approve(cashier, managerId, '9876');
      expect(granted.status).toBe(200);
      expect(granted.body.expiresIn).toBe(120);
      expect((await refund(cashier, granted.body.stepUpToken)).status).toBe(200);
      expect((await refund(cashier, granted.body.stepUpToken)).status).toBe(403);
    });

    it('refuses an approver without the permission', async () => {
      const cashier = (await pinLogin()).body.accessToken as string;
      const res = await approve(cashier, cashierId, '1234');
      expect(res.status).toBe(403);
    });

    it('refuses a wrong approver PIN', async () => {
      const cashier = (await pinLogin()).body.accessToken as string;
      expect((await approve(cashier, managerId, '0000')).status).toBe(401);
    });

    it('an approval for another action does not unlock this one', async () => {
      const cashier = (await pinLogin()).body.accessToken as string;
      const granted = await approve(cashier, managerId, '9876', 'sale.create');
      expect((await refund(cashier, granted.body.stepUpToken)).status).toBe(403);
    });
  });
});
