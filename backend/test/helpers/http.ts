import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { ADMIN_HOST, hostFor } from './fixtures.js';
import { hotp, totpCounter } from '../../src/common/crypto/totp.js';

export function refreshCookie(res: Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = raw?.find((v) => v.startsWith('pos_rt='));
  return c?.split(';')[0].slice('pos_rt='.length) || undefined;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Password login for a user without MFA. Returns the access token. */
export async function loginPassword(app: NestExpressApplication, slug: string, email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/auth/login').set('Host', hostFor(slug)).send({ email, password }).expect(200);
  if (res.body.status !== 'ok') throw new Error(`expected ok login, got ${res.body.status}`);
  return res.body.accessToken as string;
}

const lastCounter = new Map<string, number>();

/** Generates a fresh (never reused) TOTP code for this secret within the accepted window. */
export function nextTotp(secret: Buffer): string {
  const key = secret.toString('hex');
  const counter = Math.max(totpCounter(Date.now()), (lastCounter.get(key) ?? -1) + 1);
  lastCounter.set(key, counter);
  return hotp(secret, counter);
}

export async function loginSuperAdmin(app: NestExpressApplication, email: string, password: string, secret: Buffer): Promise<string> {
  const http = request(app.getHttpServer());
  const login = await http.post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email, password }).expect(200);
  const verified = await request(app.getHttpServer())
    .post('/api/platform/auth/mfa/verify')
    .set('Host', ADMIN_HOST)
    .send({ mfaToken: login.body.mfaToken, code: nextTotp(secret) })
    .expect(200);
  return verified.body.accessToken as string;
}
