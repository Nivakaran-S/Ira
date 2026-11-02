import { Controller, Get, HttpException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma.service.js';
import { RedisService } from '../../infra/redis.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      await this.redis.client.ping();
      return { status: 'ok' };
    } catch {
      throw new HttpException('Service unavailable', 503);
    }
  }
}
