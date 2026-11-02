import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppErrorFilter } from './common/errors/app-error.filter.js';
import { ConfigModule } from './config/env.js';
import { InfraModule } from './infra/infra.module.js';
import { AccessModule } from './modules/access/access.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { BackofficeModule } from './modules/backoffice/backoffice.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { SecurityModule } from './security/security.module.js';
import { HealthController } from './modules/health/health.controller.js';

@Module({
  imports: [ConfigModule, InfraModule, SecurityModule, AuditModule, AccessModule, IdentityModule, BackofficeModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AppErrorFilter }],
})
export class AppModule {}
