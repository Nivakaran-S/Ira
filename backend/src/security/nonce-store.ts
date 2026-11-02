import { Injectable } from '@nestjs/common';
import { RedisService } from '../infra/redis.service.js';

@Injectable()
export class NonceStore {
  constructor(private readonly redis: RedisService) {}

  /** True only for the first claim of a key within ttlSec. */
  async claim(key: string, ttlSec: number): Promise<boolean> {
    return (await this.redis.client.set(`nonce:${key}`, '1', 'EX', ttlSec, 'NX')) === 'OK';
  }
}
