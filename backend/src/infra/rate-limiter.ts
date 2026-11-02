import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service.js';

@Injectable()
export class RateLimiter {
  constructor(private readonly redis: RedisService) {}

  /** Fixed-window counter. Returns false once more than `limit` hits land in the window. */
  async consume(key: string, limit: number, windowSec: number): Promise<boolean> {
    const k = `rl:${key}`;
    const res = await this.redis.client.multi().incr(k).expire(k, windowSec, 'NX').exec();
    const count = Number(res?.[0]?.[1] ?? Number.POSITIVE_INFINITY);
    return count <= limit;
  }
}
