import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createSuperAdmin, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword, loginSuperAdmin } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';
const cafe = {
  key: 'cafe-x',
  name: 'Café X',
  modules: ['core', 'modifiers', 'kitchen-display'],
  roleTemplates: [{ name: 'Barista', permissions: ['sale.create'], requiresMfa: false }],
};

describe('platform configuration', () => {
  let app: NestExpressApplication;
  let admin: string;
  const http = () => request(app.getHttpServer());
  const asAdmin = (r: request.Test) => r.set('Host', ADMIN_HOST).set(bearer(admin));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret });
    admin = await loginSuperAdmin(app, 'root@pos.lk', PW, secret);
  });

  it('requires a super-admin token', async () => {
    await http().get('/api/platform/business-types').set('Host', ADMIN_HOST).expect(401);
  });

  describe('business types', () => {
    it('creates and lists', async () => {
      const created = await asAdmin(http().post('/api/platform/business-types')).send(cafe).expect(201);
      expect(created.body).toMatchObject({ key: 'cafe-x', modules: ['core', 'modifiers', 'kitchen-display'] });
      const list = await asAdmin(http().get('/api/platform/business-types')).expect(200);
      expect(list.body.map((b: { key: string }) => b.key)).toContain('cafe-x');
      expect(await ownerDb().platformAuditEvent.count({ where: { action: 'business_type.created' } })).toBe(1);
    });

    it('rejects unmet module dependencies', async () => {
      const res = await asAdmin(http().post('/api/platform/business-types')).send({ ...cafe, modules: ['core', 'kitchen-display'] }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects duplicate keys', async () => {
      await asAdmin(http().post('/api/platform/business-types')).send(cafe).expect(201);
      await asAdmin(http().post('/api/platform/business-types')).send(cafe).expect(409);
    });

    it('updating modules takes effect for tenants immediately', async () => {
      const t = await createTenant({ slug: 'acme', modules: ['core'] });
      await createUser(t.id, { email: 'a@acme.lk', password: PW });
      const token = await loginPassword(app, 'acme', 'a@acme.lk', PW);
      const before = await http().get('/api/me/capabilities').set('Host', hostFor('acme')).set(bearer(token)).expect(200);
      expect(before.body.modules).toEqual(['core']);
      const bt = await ownerDb().businessType.findUniqueOrThrow({ where: { id: t.businessTypeId } });
      await asAdmin(http().put(`/api/platform/business-types/${bt.id}`))
        .send({ key: bt.key, name: bt.name, modules: ['core', 'tables'], roleTemplates: bt.roleTemplates })
        .expect(200);
      const after = await http().get('/api/me/capabilities').set('Host', hostFor('acme')).set(bearer(token)).expect(200);
      expect(after.body.modules).toEqual(['core', 'tables']);
    });
  });

  describe('tenant module overrides', () => {
    it('refuses to enable a module whose dependency is off', async () => {
      const t = await createTenant({ slug: 'acme', modules: ['core'] });
      const res = await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'kitchen-display', enabled: true }).expect(409);
      expect(res.body.details).toEqual([{ module: 'kitchen-display', requires: 'modifiers' }]);
    });

    it('enables dependencies first, then the dependent', async () => {
      const t = await createTenant({ slug: 'acme', modules: ['core'] });
      await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'modifiers', enabled: true }).expect(200);
      const res = await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'kitchen-display', enabled: true }).expect(200);
      expect(res.body.resolved).toEqual(['core', 'kitchen-display', 'modifiers']);
    });

    it('refuses to disable a module others depend on', async () => {
      const t = await createTenant({ slug: 'acme', modules: ['core', 'modifiers', 'kitchen-display'] });
      const res = await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'modifiers', enabled: false }).expect(409);
      expect(res.body.details).toEqual([{ module: 'kitchen-display', requires: 'modifiers' }]);
    });

    it('clearing an override falls back to the business type', async () => {
      const t = await createTenant({ slug: 'acme', modules: ['core', 'tables'] });
      await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'tables', enabled: false }).expect(200);
      const cleared = await asAdmin(http().delete(`/api/platform/tenants/${t.id}/modules/tables`)).expect(200);
      expect(cleared.body).toMatchObject({ overrides: [], resolved: ['core', 'tables'] });
    });

    it('rejects overriding core', async () => {
      const t = await createTenant({ slug: 'acme' });
      await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'core', enabled: false }).expect(400);
    });

    it('404s for an unknown tenant', async () => {
      await asAdmin(http().get('/api/platform/tenants/0190b6a0-0000-7000-8000-000000000099/modules')).expect(404);
    });
  });
});
