import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessGuard } from './access.guard.js';
import { RealmCheck } from './checks/realm.check.js';
import { TenantResolverService } from './tenant-resolver.service.js';

@Global()
@Module({
  providers: [TenantResolverService, RealmCheck, { provide: APP_GUARD, useClass: AccessGuard }],
  exports: [TenantResolverService],
})
export class AccessModule {}
