import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PERMISSIONS } from '@pos/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode } from '../src/common/crypto/base32.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createBusinessType, createPlan, createSuperAdmin, hostFor } from './helpers/fixtures.js';
import { bearer, loginSuperAdmin, nextTotp } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('tenant lifecycle', () => {
  let app: NestExpressApplication;
  let admin: string;
  let businessTypeId: string;
  const http = () => request(app.getHttpServer());
  const asAdmin = (r: request.Test) => r.set('Host', ADMIN_HOST).set(bearer(admin));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    await ownerDb().plan.create({ data: { key: 'standard', name: 'Standard', maxStores: 3, maxDevices: 10, maxUsers: 25 } });
    businessTypeId = (await createBusinessType({ modules: ['core', 'tables'] })).id;
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret });
    admin = await loginSuperAdmin(app, 'root@pos.lk', PW, secret);
  });

  const newTenant = (slug = 'acme') => ({ name: 'Acme Stores', slug, businessTypeId, ownerEmail: 'owner@acme.lk', ownerName: 'Acme Owner' });

  async function ownerToken(setupCode: string, slug = 'acme') {
    const host = hostFor(slug);
    await http().post('/api/auth/setup-password').set('Host', host).send({ code: setupCode, password: PW }).expect(204);
    const login = await http().post('/api/auth/login').set('Host', host).send({ email: 'owner@acme.lk', password: PW }).expect(200);
    expect(login.body.status).toBe('mfa_setup_required');
    const verified = await http()
      .post('/api/auth/mfa/verify')
      .set('Host', host)
      .send({ mfaToken: login.body.mfaToken, code: nextTotp(base32Decode(login.body.secret)) })
      .expect(200);
    return verified.body.accessToken as string;
  }

  it('creates a tenant whose owner can onboard and holds every permission', async () => {
    const res = await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    expect(res.body).toMatchObject({ host: 'acme.pos.localhost', owner: { email: 'owner@acme.lk' }, tenant: { slug: 'acme', status: 'ACTIVE' } });
    expect(res.body.ownerSetupCode).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const roles = await ownerDb().role.findMany({ where: { tenantId: res.body.tenant.id }, orderBy: { name: 'asc' } });
    expect(roles.map((r) => r.name)).toEqual(['Cashier', 'Owner']);
    expect(roles.find((r) => r.name === 'Owner')).toMatchObject({ requiresMfa: true, isSystem: true });

    const token = await ownerToken(res.body.ownerSetupCode);
    const caps = await http().get('/api/me/capabilities').set('Host', hostFor('acme')).set(bearer(token)).expect(200);
    expect(caps.body.permissions).toEqual([...PERMISSIONS].sort());
    expect(caps.body.modules).toEqual(['core', 'tables']);
    expect(await ownerDb().platformAuditEvent.count({ where: { action: 'tenant.created' } })).toBe(1);
  });

  it('clears a cached "unknown host" when the tenant is created', async () => {
    await http().post('/api/auth/login').set('Host', hostFor('acme')).send({ email: 'x@y.lk', password: 'x' }).expect(404);
    const res = await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    await http().post('/api/auth/setup-password').set('Host', hostFor('acme')).send({ code: res.body.ownerSetupCode, password: PW }).expect(204);
  });

  it('rejects duplicate and reserved slugs, unknown business types and plans', async () => {
    await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(409);
    await asAdmin(http().post('/api/platform/tenants')).send(newTenant('admin')).expect(400);
    await asAdmin(http().post('/api/platform/tenants')).send({ ...newTenant('zeta'), businessTypeId: '0190b6a0-0000-7000-8000-000000000099' }).expect(404);
    await asAdmin(http().post('/api/platform/tenants')).send({ ...newTenant('zeta'), planKey: 'nope' }).expect(404);
  });

  it('suspension takes effect immediately and is reversible', async () => {
    const res = await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    const token = await ownerToken(res.body.ownerSetupCode);
    await asAdmin(http().patch(`/api/platform/tenants/${res.body.tenant.id}/status`)).send({ status: 'SUSPENDED' }).expect(200);
    const blocked = await http().get('/api/me').set('Host', hostFor('acme')).set(bearer(token)).expect(403);
    expect(blocked.body.code).toBe('TENANT_SUSPENDED');
    await asAdmin(http().patch(`/api/platform/tenants/${res.body.tenant.id}/status`)).send({ status: 'ACTIVE' }).expect(200);
    await http().get('/api/me').set('Host', hostFor('acme')).set(bearer(token)).expect(200);
  });

  it('changing the business type switches modules and adds missing template roles', async () => {
    const res = await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    const token = await ownerToken(res.body.ownerSetupCode);
    const pharmacy = await ownerDb().businessType.create({
      data: {
        key: 'pharmacy-x',
        name: 'Pharmacy',
        modules: ['core', 'customers', 'batch-expiry', 'prescriptions'],
        roleTemplates: [
          { name: 'Cashier', permissions: ['sale.create'], requiresMfa: false },
          { name: 'Pharmacist', permissions: ['sale.create', 'sale.refund'], requiresMfa: true },
        ],
      },
    });
    await asAdmin(http().patch(`/api/platform/tenants/${res.body.tenant.id}/business-type`)).send({ businessTypeId: pharmacy.id }).expect(200);
    const caps = await http().get('/api/me/capabilities').set('Host', hostFor('acme')).set(bearer(token)).expect(200);
    expect(caps.body.modules).toEqual(['batch-expiry', 'core', 'customers', 'prescriptions']);
    const roles = await ownerDb().role.findMany({ where: { tenantId: res.body.tenant.id }, orderBy: { name: 'asc' } });
    expect(roles.map((r) => r.name)).toEqual(['Cashier', 'Owner', 'Pharmacist']);
  });

  it('soft-deletes: the host disappears and the tenant leaves the list', async () => {
    const res = await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    await asAdmin(http().delete(`/api/platform/tenants/${res.body.tenant.id}`)).expect(204);
    await http().post('/api/auth/login').set('Host', hostFor('acme')).send({ email: 'owner@acme.lk', password: PW }).expect(404);
    const list = await asAdmin(http().get('/api/platform/tenants')).expect(200);
    expect(list.body).toEqual([]);
  });

  it('uses the plan the request names', async () => {
    const premium = await createPlan({ maxStores: 50 });
    const res = await asAdmin(http().post('/api/platform/tenants')).send({ ...newTenant(), planKey: premium.key }).expect(201);
    expect(res.body.tenant.plan.key).toBe(premium.key);
  });
});
