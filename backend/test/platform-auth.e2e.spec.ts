import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode } from '../src/common/crypto/base32.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createSuperAdmin, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword, loginSuperAdmin, nextTotp, refreshCookie } from './helpers/http.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('super-admin authentication', () => {
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

  it('bootstraps: setup code → password → mandatory TOTP enrolment → platform token', async () => {
    await createSuperAdmin({ email: 'root@pos.lk', setupCode: 'platform-setup-code-123' });
    await http().post('/api/platform/auth/setup-password').set('Host', ADMIN_HOST).send({ code: 'platform-setup-code-123', password: PW }).expect(204);
    const login = await http().post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email: 'root@pos.lk', password: PW }).expect(200);
    expect(login.body.status).toBe('mfa_setup_required');
    const secret = base32Decode(login.body.secret);
    const verified = await http().post('/api/platform/auth/mfa/verify').set('Host', ADMIN_HOST).send({ mfaToken: login.body.mfaToken, code: nextTotp(secret) }).expect(200);
    const me = await http().get('/api/probe/platform-authed').set('Host', ADMIN_HOST).set(bearer(verified.body.accessToken)).expect(200);
    expect(me.body.realm).toBe('platform');
    const again = await http().post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email: 'root@pos.lk', password: PW }).expect(200);
    expect(again.body.status).toBe('mfa_required');
  });

  it('platform auth routes do not exist on tenant hosts', async () => {
    await createTenant({ slug: 'acme' });
    await http().post('/api/platform/auth/login').set('Host', hostFor('acme')).send({ email: 'root@pos.lk', password: PW }).expect(404);
  });

  it('keeps the realms apart: tokens only work on their own audience', async () => {
    const t = await createTenant({ slug: 'acme' });
    await createUser(t.id, { email: 'a@acme.lk', password: PW });
    const tenantToken = await loginPassword(app, 'acme', 'a@acme.lk', PW);
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret });
    const platformToken = await loginSuperAdmin(app, 'root@pos.lk', PW, secret);

    await http().get('/api/probe/platform-authed').set('Host', ADMIN_HOST).set(bearer(tenantToken)).expect(401);
    await http().get('/api/probe/authed').set('Host', hostFor('acme')).set(bearer(platformToken)).expect(401);
  });

  it('rejects a tenant MFA token at the platform verify endpoint', async () => {
    const t = await createTenant({ slug: 'acme' });
    const secret = randomBytes(20);
    await createUser(t.id, { email: 'mgr@acme.lk', password: PW, totpSecret: secret });
    const login = await http().post('/api/auth/login').set('Host', hostFor('acme')).send({ email: 'mgr@acme.lk', password: PW }).expect(200);
    await http().post('/api/platform/auth/mfa/verify').set('Host', ADMIN_HOST).send({ mfaToken: login.body.mfaToken, code: nextTotp(secret) }).expect(401);
  });

  it('locks a super admin after 5 failed passwords', async () => {
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: randomBytes(20) });
    for (let i = 0; i < 5; i++) await http().post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email: 'root@pos.lk', password: 'bad' }).expect(401);
    await http().post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email: 'root@pos.lk', password: PW }).expect(423);
    expect(await ownerDb().platformAuditEvent.count({ where: { action: 'platform.auth.password_failed' } })).toBe(5);
  });

  it('rotates platform refresh tokens and detects reuse', async () => {
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret });
    const login = await http().post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email: 'root@pos.lk', password: PW });
    const verified = await http().post('/api/platform/auth/mfa/verify').set('Host', ADMIN_HOST).send({ mfaToken: login.body.mfaToken, code: nextTotp(secret) });
    const cookie = (verified.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pos_rt='))!;
    expect(cookie).toMatch(/Path=\/api\/platform\/auth/);
    const rt1 = refreshCookie(verified)!;
    const r2 = await http().post('/api/platform/auth/refresh').set('Host', ADMIN_HOST).set('Cookie', `pos_rt=${rt1}`).expect(200);
    await http().post('/api/platform/auth/refresh').set('Host', ADMIN_HOST).set('Cookie', `pos_rt=${rt1}`).expect(401);
    await http().post('/api/platform/auth/refresh').set('Host', ADMIN_HOST).set('Cookie', `pos_rt=${refreshCookie(r2)}`).expect(401);
  });
});
