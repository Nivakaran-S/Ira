import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { RateLimiter } from './rate-limiter.js';
import { RedisService } from './redis.service.js';
import { TenantDb } from './tenant-db.service.js';

@Global()
@Module({
  providers: [PrismaService, TenantDb, RedisService, RateLimiter],
  exports: [PrismaService, TenantDb, RedisService, RateLimiter],
})
export class InfraModule {}
