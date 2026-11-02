import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode } from '../src/common/crypto/base32.js';
import { hotp, totp, totpCounter } from '../src/common/crypto/totp.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword, refreshCookie } from './helpers/http.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('tenant authentication', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme' })).id;
  });

  describe('password login', () => {
    it('issues an access token and a hardened refresh cookie', async () => {
      const { user } = await createUser(tenantId, { email: 'cashier@acme.lk', password: PW });
      const res = await http().post('/api/auth/login').set('Host', host).send({ email: 'CASHIER@acme.lk', password: PW }).expect(200);
      expect(res.body.status).toBe('ok');
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pos_rt='))!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api\/auth/);
      const me = await http().get('/api/probe/authed').set('Host', host).set(bearer(res.body.accessToken)).expect(200);
      expect(me.body).toMatchObject({ realm: 'tenant', userId: user.id, tenantId });
    });

    it('gives the same answer for unknown email and wrong password', async () => {
      await createUser(tenantId, { email: 'a@acme.lk', password: PW });
      const wrong = await http().post('/api/auth/login').set('Host', host).send({ email: 'a@acme.lk', password: 'nope' }).expect(401);
      const unknown = await http().post('/api/auth/login').set('Host', host).send({ email: 'z@acme.lk', password: 'nope' }).expect(401);
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('locks the account after 5 failures, even for the right password', async () => {
      await createUser(tenantId, { email: 'a@acme.lk', password: PW });
      for (let i = 0; i < 5; i++) await http().post('/api/auth/login').set('Host', host).send({ email: 'a@acme.lk', password: 'bad' }).expect(401);
      const res = await http().post('/api/auth/login').set('Host', host).send({ email: 'a@acme.lk', password: PW }).expect(423);
      expect(res.body.code).toBe('ACCOUNT_LOCKED');
      const events = await ownerDb().auditEvent.findMany({ where: { action: 'auth.password_failed' } });
      expect(events).toHaveLength(5);
    });

    it('rate-limits repeated attempts on one email', async () => {
      for (let i = 0; i < 10; i++) await http().post('/api/auth/login').set('Host', host).send({ email: 'x@acme.lk', password: 'bad' });
      const res = await http().post('/api/auth/login').set('Host', host).send({ email: 'x@acme.lk', password: 'bad' }).expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
    });

    it('rejects requests without a token and with a garbage token', async () => {
      await http().get('/api/probe/authed').set('Host', host).expect(401);
      await http().get('/api/probe/authed').set('Host', host).set(bearer('garbage')).expect(401);
    });
  });

  describe('MFA', () => {
    it('enrols TOTP on first login when a role requires MFA, then requires it', async () => {
      await createUser(tenantId, { email: 'mgr@acme.lk', password: PW, requiresMfa: true });
      const first = await http().post('/api/auth/login').set('Host', host).send({ email: 'mgr@acme.lk', password: PW }).expect(200);
      expect(first.body.status).toBe('mfa_setup_required');
      expect(first.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      const secret = base32Decode(first.body.secret);
      const enrolmentCode = totp(secret);

      const verified = await http().post('/api/auth/mfa/verify').set('Host', host).send({ mfaToken: first.body.mfaToken, code: enrolmentCode }).expect(200);
      expect(verified.body.accessToken).toBeTruthy();
      expect(refreshCookie(verified)).toBeTruthy();

      const second = await http().post('/api/auth/login').set('Host', host).send({ email: 'mgr@acme.lk', password: PW }).expect(200);
      expect(second.body).toEqual({ status: 'mfa_required', mfaToken: expect.any(String) });
      // The code used for enrolment cannot be replayed.
      await http().post('/api/auth/mfa/verify').set('Host', host).send({ mfaToken: second.body.mfaToken, code: enrolmentCode }).expect(401);
      // The next step's code works.
      const next = hotp(secret, totpCounter(Date.now()) + 1);
      await http().post('/api/auth/mfa/verify').set('Host', host).send({ mfaToken: second.body.mfaToken, code: next }).expect(200);
    });

    it('rejects an MFA token presented on another tenant host', async () => {
      await createTenant({ slug: 'other' });
      const secret = randomBytes(20);
      await createUser(tenantId, { email: 'mgr@acme.lk', password: PW, requiresMfa: true, totpSecret: secret });
      const login = await http().post('/api/auth/login').set('Host', host).send({ email: 'mgr@acme.lk', password: PW }).expect(200);
      await http().post('/api/auth/mfa/verify').set('Host', hostFor('other')).send({ mfaToken: login.body.mfaToken, code: totp(secret) }).expect(401);
    });
  });

  describe('setup codes', () => {
    it('sets the password once with a valid code', async () => {
      await createUser(tenantId, { email: 'new@acme.lk', setupCode: 'setup-code-1234567890' });
      await http().post('/api/auth/setup-password').set('Host', host).send({ code: 'setup-code-1234567890', password: PW }).expect(204);
      await loginPassword(app, 'acme', 'new@acme.lk', PW);
      await http().post('/api/auth/setup-password').set('Host', host).send({ code: 'setup-code-1234567890', password: PW }).expect(401);
    });

    it('rejects short passwords', async () => {
      await createUser(tenantId, { email: 'new@acme.lk', setupCode: 'setup-code-1234567890' });
      const res = await http().post('/api/auth/setup-password').set('Host', host).send({ code: 'setup-code-1234567890', password: 'short' }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('refresh rotation', () => {
    async function login() {
      await createUser(tenantId, { email: 'a@acme.lk', password: PW });
      const res = await http().post('/api/auth/login').set('Host', host).send({ email: 'a@acme.lk', password: PW }).expect(200);
      return refreshCookie(res)!;
    }

    it('rotates the refresh token', async () => {
      const rt1 = await login();
      const res = await http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt1}`).expect(200);
      const rt2 = refreshCookie(res)!;
      expect(rt2).not.toBe(rt1);
      expect(res.body.accessToken).toBeTruthy();
    });

    it('revokes the whole family when a used token is replayed', async () => {
      const rt1 = await login();
      const res = await http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt1}`).expect(200);
      const rt2 = refreshCookie(res)!;
      const access2 = res.body.accessToken as string;
      await http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt1}`).expect(401);
      await http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt2}`).expect(401);
      await http().get('/api/probe/authed').set('Host', host).set(bearer(access2)).expect(401);
      expect(await ownerDb().auditEvent.count({ where: { action: 'auth.refresh_reuse' } })).toBe(1);
    });

    it('concurrent refresh: exactly one succeeds', async () => {
      const rt1 = await login();
      const results = await Promise.all(
        [0, 1].map(() => http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt1}`)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('refuses refresh tokens on another tenant host', async () => {
      await createTenant({ slug: 'other' });
      const rt1 = await login();
      await http().post('/api/auth/refresh').set('Host', hostFor('other')).set('Cookie', `pos_rt=${rt1}`).expect(401);
    });
  });

  it('logout revokes the session immediately', async () => {
    await createUser(tenantId, { email: 'a@acme.lk', password: PW });
    const token = await loginPassword(app, 'acme', 'a@acme.lk', PW);
    await http().post('/api/auth/logout').set('Host', host).set(bearer(token)).expect(204);
    await http().get('/api/probe/authed').set('Host', host).set(bearer(token)).expect(401);
  });

  it('a token for tenant A is refused on tenant B and audited in B', async () => {
    const b = await createTenant({ slug: 'bravo' });
    await createUser(tenantId, { email: 'a@acme.lk', password: PW });
    const token = await loginPassword(app, 'acme', 'a@acme.lk', PW);
    const res = await http().get('/api/probe/authed').set('Host', hostFor('bravo')).set(bearer(token)).expect(403);
    expect(res.body.code).toBe('TENANT_MISMATCH');
    expect(await ownerDb().auditEvent.count({ where: { tenantId: b.id, action: 'auth.tenant_mismatch' } })).toBe(1);
  });
});
