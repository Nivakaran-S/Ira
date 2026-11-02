import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { hostFor } from './fixtures.js';

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
