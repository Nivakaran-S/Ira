import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  PLATFORM_DOMAIN: 'pos.localhost',
  JWT_PRIVATE_KEY: 'x',
  JWT_PUBLIC_KEY: 'y',
  PII_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadEnv', () => {
  it('parses a valid environment with defaults', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.PLATFORM_IP_ALLOWLIST).toEqual([]);
  });

  it('splits the IP allowlist', () => {
    expect(loadEnv({ ...valid, PLATFORM_IP_ALLOWLIST: '1.2.3.4, 5.6.7.8' }).PLATFORM_IP_ALLOWLIST).toEqual(['1.2.3.4', '5.6.7.8']);
  });

  it('rejects a PII key that is not 32 bytes, without echoing the value', () => {
    const secret = Buffer.alloc(16, 7).toString('base64');
    expect(() => loadEnv({ ...valid, PII_KEY: secret })).toThrowError(/PII_KEY/);
    try {
      loadEnv({ ...valid, PII_KEY: secret });
    } catch (e) {
      expect(String(e)).not.toContain(secret);
    }
  });
});
