import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENV, loadEnv } from '../src/config/env.js';
import { TenantResolverService } from '../src/modules/access/tenant-resolver.service.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createTenant, hostFor } from './helpers/fixtures.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

describe('tenant resolution and realms', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
  });

  it('resolves {slug}.platform-domain to the tenant', async () => {
    const t = await createTenant({ slug: 'acme' });
    const res = await http().get('/api/probe/tenant').set('Host', hostFor('acme')).expect(200);
    expect(res.body).toEqual({ realm: 'tenant', tenantId: t.id });
  });

  it('ignores the port in the Host header', async () => {
    const t = await createTenant({ slug: 'acme' });
    const res = await http().get('/api/probe/tenant').set('Host', `${hostFor('acme')}:8443`).expect(200);
    expect(res.body.tenantId).toBe(t.id);
  });

  it.each(['nobody.pos.localhost', 'x.acme.pos.localhost', 'pos.localhost', 'evil.com'])('returns 404 for unknown host %s', async (host) => {
    await createTenant({ slug: 'acme' });
    const res = await http().get('/api/probe/tenant').set('Host', host).expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('resolves a verified custom domain but not an unverified one', async () => {
    const t = await createTenant({ slug: 'acme' });
    await ownerDb().domain.create({ data: { tenantId: t.id, hostname: 'shop.acme.lk', verificationToken: 'x', verifiedAt: new Date() } });
    await ownerDb().domain.create({ data: { tenantId: t.id, hostname: 'pending.acme.lk', verificationToken: 'y' } });
    expect((await http().get('/api/probe/tenant').set('Host', 'shop.acme.lk').expect(200)).body.tenantId).toBe(t.id);
    await http().get('/api/probe/tenant').set('Host', 'pending.acme.lk').expect(404);
  });

  it('does not resolve soft-deleted tenants', async () => {
    const t = await createTenant({ slug: 'acme' });
    await ownerDb().tenant.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
    await http().get('/api/probe/tenant').set('Host', hostFor('acme')).expect(404);
  });

  it('serves platform routes only on the admin host', async () => {
    await createTenant({ slug: 'acme' });
    await http().get('/api/probe/platform').set('Host', ADMIN_HOST).expect(200);
    await http().get('/api/probe/platform').set('Host', hostFor('acme')).expect(404);
    await http().get('/api/probe/tenant').set('Host', ADMIN_HOST).expect(404);
  });

  it('serves realm-any routes on any host', async () => {
    const res = await http().get('/api/probe/any').set('Host', 'localhost').expect(200);
    expect(res.body).toEqual({ realm: 'unknown' });
    await http().get('/api/health').set('Host', 'localhost').expect(200);
  });

  it('invalidateTenant drops cached resolution', async () => {
    const t = await createTenant({ slug: 'acme' });
    const resolver = app.get(TenantResolverService);
    expect((await resolver.resolveHost(hostFor('acme'))).tenant?.status).toBe('ACTIVE');
    await ownerDb().tenant.update({ where: { id: t.id }, data: { status: 'SUSPENDED' } });
    expect((await resolver.resolveHost(hostFor('acme'))).tenant?.status).toBe('ACTIVE'); // cached
    await resolver.invalidateTenant(t.id);
    expect((await resolver.resolveHost(hostFor('acme'))).tenant?.status).toBe('SUSPENDED');
  });
});

describe('platform IP allowlist', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp({
      controllers: [ProbeController],
      customize: (b) => b.overrideProvider(ENV).useValue({ ...loadEnv(), PLATFORM_IP_ALLOWLIST: ['10.9.9.9'] }),
    });
  });
  afterAll(() => app.close());
  afterEach(flushRedis);

  it('hides platform routes from IPs outside the allowlist', async () => {
    await request(app.getHttpServer()).get('/api/probe/platform').set('Host', ADMIN_HOST).expect(404);
  });
});
