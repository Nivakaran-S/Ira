import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantResolverService } from '../src/modules/access/tenant-resolver.service.js';
import { DNS_RESOLVER, type DnsResolver, DomainsService } from '../src/modules/platform/domains.service.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createSuperAdmin, createTenant, hostFor } from './helpers/fixtures.js';
import { bearer, loginSuperAdmin } from './helpers/http.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';
const txt = new Map<string, string[][] | Error>();
const fakeDns: DnsResolver = {
  async resolveTxt(name) {
    const v = txt.get(name);
    if (v instanceof Error) throw v;
    if (!v) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
    return v;
  },
};

describe('custom domains', () => {
  let app: NestExpressApplication;
  let admin: string;
  let tenantId: string;
  const http = () => request(app.getHttpServer());
  const asAdmin = (r: request.Test) => r.set('Host', ADMIN_HOST).set(bearer(admin));

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController], customize: (b) => b.overrideProvider(DNS_RESOLVER).useValue(fakeDns) });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    txt.clear();
    tenantId = (await createTenant({ slug: 'acme' })).id;
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret });
    admin = await loginSuperAdmin(app, 'root@pos.lk', PW, secret);
  });

  async function addDomain(hostname = 'shop.acme.lk') {
    return asAdmin(http().post(`/api/platform/tenants/${tenantId}/domains`)).send({ hostname }).expect(201);
  }

  it('returns TXT instructions, verifies, then serves the tenant on that host', async () => {
    const added = await addDomain('Shop.Acme.LK');
    expect(added.body).toMatchObject({ hostname: 'shop.acme.lk', txtName: '_pos-verify.shop.acme.lk', verifiedAt: null });
    expect(added.body.txtValue).toMatch(/^pos-verify=/);
    await http().get('/api/probe/tenant').set('Host', 'shop.acme.lk').expect(404);

    txt.set('_pos-verify.shop.acme.lk', [['some-other-record'], [added.body.txtValue]]);
    const verified = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/domains/${added.body.id}/verify`)).expect(200);
    expect(verified.body.verified).toBe(true);
    const probe = await http().get('/api/probe/tenant').set('Host', 'shop.acme.lk').expect(200);
    expect(probe.body.tenantId).toBe(tenantId);
  });

  it('stays unverified when the TXT value is wrong', async () => {
    const added = await addDomain();
    txt.set('_pos-verify.shop.acme.lk', [['pos-verify=wrong']]);
    const res = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/domains/${added.body.id}/verify`)).expect(200);
    expect(res.body.verified).toBe(false);
  });

  it('refuses platform-domain hostnames and duplicates', async () => {
    await asAdmin(http().post(`/api/platform/tenants/${tenantId}/domains`)).send({ hostname: 'evil.pos.localhost' }).expect(400);
    await addDomain();
    const other = await createTenant({ slug: 'other' });
    await asAdmin(http().post(`/api/platform/tenants/${other.id}/domains`)).send({ hostname: 'shop.acme.lk' }).expect(409);
  });

  it('cannot verify another tenant’s domain through the wrong tenant path', async () => {
    const added = await addDomain();
    const other = await createTenant({ slug: 'other' });
    await asAdmin(http().post(`/api/platform/tenants/${other.id}/domains/${added.body.id}/verify`)).expect(404);
  });

  describe('caddy ask', () => {
    const ask = (domain: string) => http().get(`/api/internal/caddy/ask?domain=${encodeURIComponent(domain)}`).set('Host', 'localhost');

    it('allows the admin host, active slugs and verified domains only', async () => {
      await createTenant({ slug: 'sleepy', status: 'SUSPENDED' });
      const added = await addDomain();
      await ask(ADMIN_HOST).expect(200);
      await ask(hostFor('acme')).expect(200);
      await ask(hostFor('nobody')).expect(404);
      await ask(hostFor('sleepy')).expect(404);
      await ask('shop.acme.lk').expect(404);
      await ownerDb().domain.update({ where: { id: added.body.id }, data: { verifiedAt: new Date() } });
      await app.get(TenantResolverService).invalidateHosts(['shop.acme.lk']); // the 404 above was cached
      await ask('shop.acme.lk').expect(200);
      await http().get('/api/internal/caddy/ask').set('Host', 'localhost').expect(404);
    });
  });

  describe('daily recheck', () => {
    it('unverifies domains whose record is gone, keeps them on transient DNS errors', async () => {
      const gone = await addDomain('gone.acme.lk');
      const flaky = await addDomain('flaky.acme.lk');
      await ownerDb().domain.updateMany({ data: { verifiedAt: new Date() } });
      txt.set('_pos-verify.flaky.acme.lk', Object.assign(new Error('queryTxt ETIMEOUT'), { code: 'ETIMEOUT' }));
      const result = await app.get(DomainsService).recheckAll();
      expect(result).toEqual({ checked: 2, unverified: 1 });
      const rows = await ownerDb().domain.findMany({ orderBy: { hostname: 'asc' } });
      expect(rows.find((d) => d.id === flaky.body.id)?.verifiedAt).not.toBeNull();
      expect(rows.find((d) => d.id === gone.body.id)?.verifiedAt).toBeNull();
      await http().get('/api/probe/tenant').set('Host', 'gone.acme.lk').expect(404);
    });
  });
});
