import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessGuard } from './access.guard.js';
import { CapabilitiesService } from './capabilities.service.js';
import { AuthCheck } from './checks/auth.check.js';
import { DeviceCheck } from './checks/device.check.js';
import { ModuleCheck } from './checks/module.check.js';
import { PermissionCheck } from './checks/permission.check.js';
import { RealmCheck } from './checks/realm.check.js';
import { StepUpCheck } from './checks/step-up.check.js';
import { TenantStatusCheck } from './checks/tenant-status.check.js';
import { PlanLimitsService } from './plan-limits.service.js';
import { TenantResolverService } from './tenant-resolver.service.js';

@Global()
@Module({
  providers: [
    TenantResolverService,
    CapabilitiesService,
    PlanLimitsService,
    RealmCheck,
    TenantStatusCheck,
    AuthCheck,
    DeviceCheck,
    ModuleCheck,
    PermissionCheck,
    StepUpCheck,
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [TenantResolverService, CapabilitiesService, PlanLimitsService],
})
export class AccessModule {}
