import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '../src/config/env.js';
import { InfraModule } from '../src/infra/infra.module.js';
import { RateLimiter } from '../src/infra/rate-limiter.js';
import { flushRedis } from './helpers/redis.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, InfraModule] }).compile();
    await moduleRef.init();
    limiter = moduleRef.get(RateLimiter);
    close = () => moduleRef.close();
  });
  afterAll(() => close());
  beforeEach(flushRedis);

  it('allows up to the limit then blocks', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.consume('k1', 3, 60));
    expect(results).toEqual([true, true, true, false]);
  });

  it('keeps keys independent', async () => {
    await limiter.consume('a', 1, 60);
    expect(await limiter.consume('a', 1, 60)).toBe(false);
    expect(await limiter.consume('b', 1, 60)).toBe(true);
  });
});
