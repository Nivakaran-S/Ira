import { Injectable } from '@nestjs/common';
import { RedisService } from '../infra/redis.service.js';

/** Revoked session ids, kept at least as long as any access token for them can live. */
@Injectable()
export class RevocationStore {
  constructor(private readonly redis: RedisService) {}

  async markRevoked(sessionId: string, ttlSec = 300): Promise<void> {
    await this.redis.client.set(`revoked:${sessionId}`, '1', 'EX', ttlSec);
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    return (await this.redis.client.exists(`revoked:${sessionId}`)) === 1;
  }
}
