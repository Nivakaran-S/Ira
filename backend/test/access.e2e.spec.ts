import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CapabilitiesService } from '../src/modules/access/capabilities.service.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('tenant status, modules, permissions', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
  });

  it('blocks every tenant route of a suspended tenant, including login', async () => {
    const t = await createTenant({ slug: 'acme', status: 'SUSPENDED' });
    await createUser(t.id, { email: 'a@acme.lk', password: PW });
    const res = await http().post('/api/auth/login').set('Host', host).send({ email: 'a@acme.lk', password: PW }).expect(403);
    expect(res.body.code).toBe('TENANT_SUSPENDED');
  });

  it('refuses routes of disabled modules and allows them once enabled', async () => {
    const t = await createTenant({ slug: 'acme', modules: ['core'] });
    await createUser(t.id, { email: 'a@acme.lk', password: PW });
    const token = await loginPassword(app, 'acme', 'a@acme.lk', PW);
    const denied = await http().get('/api/probe/tables').set('Host', host).set(bearer(token)).expect(403);
    expect(denied.body.code).toBe('MODULE_DISABLED');

    await ownerDb().tenantModule.create({ data: { tenantId: t.id, moduleKey: 'tables', enabled: true } });
    await app.get(CapabilitiesService).invalidateModules([t.id]);
    await http().get('/api/probe/tables').set('Host', host).set(bearer(token)).expect(200);
  });

  it('enforces route permissions', async () => {
    const t = await createTenant({ slug: 'acme' });
    await createUser(t.id, { email: 'cashier@acme.lk', password: PW, permissions: ['sale.create'] });
    await createUser(t.id, { email: 'mgr@acme.lk', password: PW, permissions: ['sale.refund'] });
    const cashier = await loginPassword(app, 'acme', 'cashier@acme.lk', PW);
    const mgr = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
    const res = await http().get('/api/probe/refund-permission').set('Host', host).set(bearer(cashier)).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await http().get('/api/probe/refund-permission').set('Host', host).set(bearer(mgr)).expect(200);
  });

  it('a disabled user keeps no permissions even with a live token', async () => {
    const t = await createTenant({ slug: 'acme' });
    const { user } = await createUser(t.id, { email: 'mgr@acme.lk', password: PW, permissions: ['sale.refund'] });
    const token = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
    await ownerDb().user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    await http().get('/api/probe/refund-permission').set('Host', host).set(bearer(token)).expect(403);
  });

  it('GET /me and /me/capabilities describe the caller', async () => {
    const t = await createTenant({ slug: 'acme', modules: ['core', 'tables', 'modifiers'] });
    const { user } = await createUser(t.id, { email: 'mgr@acme.lk', password: PW, permissions: ['sale.refund', 'sale.create'] });
    const token = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
    const me = await http().get('/api/me').set('Host', host).set(bearer(token)).expect(200);
    expect(me.body).toEqual({
      user: { id: user.id, name: 'Test User', email: 'mgr@acme.lk' },
      tenant: { id: t.id, name: 'Tenant acme', slug: 'acme' },
      impersonatedBy: null,
      deviceId: null,
    });
    const caps = await http().get('/api/me/capabilities').set('Host', host).set(bearer(token)).expect(200);
    expect(caps.body).toEqual({ modules: ['core', 'modifiers', 'tables'], permissions: ['sale.create', 'sale.refund'], impersonatedBy: null });
  });
});
