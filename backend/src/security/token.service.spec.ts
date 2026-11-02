import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import { TokenService } from './token.service.js';

describe('TokenService', () => {
  const svc = new TokenService(loadEnv());
  beforeAll(() => svc.onModuleInit());
  afterEach(() => vi.useRealTimers());

  it('signs and verifies with the right audience', async () => {
    const token = await svc.sign('tenant', { sub: 'u1', tid: 't1' }, 300);
    const claims = await svc.verify<{ tid: string }>(token, 'tenant');
    expect(claims).toMatchObject({ sub: 'u1', tid: 't1', iss: 'pos', aud: 'tenant' });
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects the wrong audience', async () => {
    const token = await svc.sign('tenant', { sub: 'u1' }, 300);
    await expect(svc.verify(token, 'platform')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects expired tokens', async () => {
    const token = await svc.sign('tenant', { sub: 'u1' }, 300);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 301_000);
    await expect(svc.verify(token, 'tenant')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects tokens signed by another key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const other = new TokenService(
      loadEnv({
        ...process.env,
        JWT_PRIVATE_KEY: b64(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
        JWT_PUBLIC_KEY: b64(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
      }),
    );
    await other.onModuleInit();
    const forged = await other.sign('tenant', { sub: 'u1' }, 300);
    await expect(svc.verify(forged, 'tenant')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects unsigned (alg: none) tokens', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: 'none' })}.${enc({ sub: 'u1', aud: 'tenant', iss: 'pos', exp: now + 60 })}.`;
    await expect(svc.verify(unsigned, 'tenant')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
