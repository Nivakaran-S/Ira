import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createRegister, createStore, createSuperAdmin, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginSuperAdmin } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('impersonation', () => {
  let app: NestExpressApplication;
  let admin: string;
  let adminId: string;
  let tenantId: string;
  let ownerId: string;
  const http = () => request(app.getHttpServer());
  const asAdmin = (r: request.Test) => r.set('Host', ADMIN_HOST).set(bearer(admin));
  const reason = 'Customer ticket #4411: cannot see their registers';

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme' })).id;
    // The system Owner role, as tenant creation makes it.
    const ownerRole = await ownerDb().role.create({
      data: { tenantId, name: 'Owner', permissions: ['device.enroll', 'store.manage'], requiresMfa: true, isSystem: true },
    });
    const { user } = await createUser(tenantId, { email: 'owner@acme.lk', password: PW });
    await ownerDb().userRole.create({ data: { tenantId, userId: user.id, roleId: ownerRole.id } });
    ownerId = user.id;
    const secret = randomBytes(20);
    adminId = (await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret })).id;
    admin = await loginSuperAdmin(app, 'root@pos.lk', PW, secret);
  });

  it('requires a real reason', async () => {
    await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason: 'because' }).expect(400);
  });

  it('issues a 30-minute token for the owner, visibly marked as impersonated', async () => {
    const res = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason }).expect(201);
    expect(res.body).toMatchObject({ expiresIn: 1800, host: 'acme.pos.localhost', userId: ownerId });
    const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(1800);
    expect(payload.imp).toBe(adminId);

    const me = await http().get('/api/me').set('Host', hostFor('acme')).set(bearer(res.body.accessToken)).expect(200);
    expect(me.body).toMatchObject({ user: { id: ownerId }, impersonatedBy: adminId });
  });

  it('records the reason in both audit logs and tags actions taken while impersonating', async () => {
    const res = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason }).expect(201);
    const register = await createRegister(tenantId, (await createStore(tenantId)).id);
    await http().post('/api/devices/enrollments').set('Host', hostFor('acme')).set(bearer(res.body.accessToken)).send({ registerId: register.id }).expect(201);

    const started = await ownerDb().auditEvent.findFirstOrThrow({ where: { action: 'impersonation.started' } });
    expect(started).toMatchObject({ tenantId, impersonatorId: adminId, actorUserId: ownerId, after: { reason, sessionId: res.body.sessionId } });
    const action = await ownerDb().auditEvent.findFirstOrThrow({ where: { action: 'device.enrollment_created' } });
    expect(action).toMatchObject({ actorUserId: ownerId, impersonatorId: adminId });
    expect(await ownerDb().platformAuditEvent.count({ where: { action: 'tenant.impersonation_started' } })).toBe(1);
  });

  it('the token only works on that tenant', async () => {
    await createTenant({ slug: 'other' });
    const res = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason }).expect(201);
    await http().get('/api/me').set('Host', hostFor('other')).set(bearer(res.body.accessToken)).expect(403);
  });

  it('ending impersonation kills the token', async () => {
    const res = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason }).expect(201);
    await asAdmin(http().post(`/api/platform/impersonations/${res.body.sessionId}/end`)).expect(204);
    await http().get('/api/me').set('Host', hostFor('acme')).set(bearer(res.body.accessToken)).expect(401);
  });

  it('refuses suspended tenants and unknown users', async () => {
    await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`))
      .send({ reason, userId: '0190b6a0-0000-7000-8000-000000000099' })
      .expect(404);
    await ownerDb().tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
    await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason }).expect(409);
  });
});
