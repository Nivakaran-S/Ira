import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppErrorFilter } from './common/errors/app-error.filter.js';
import { ConfigModule } from './config/env.js';
import { HealthController } from './modules/health/health.controller.js';

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AppErrorFilter }],
})
export class AppModule {}
