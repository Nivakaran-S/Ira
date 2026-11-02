import { Module } from '@nestjs/common';
import { BusinessTypesController } from './business-types.controller.js';
import { BusinessTypesService } from './business-types.service.js';
import { CaddyController } from './caddy.controller.js';
import { DomainRecheckJob } from './domain-recheck.job.js';
import { DomainsController } from './domains.controller.js';
import { DNS_RESOLVER, DomainsService, systemDnsResolver } from './domains.service.js';
import { ImpersonationController } from './impersonation.controller.js';
import { ImpersonationService } from './impersonation.service.js';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformSessionService } from './platform-session.service.js';
import { TenantModulesController } from './tenant-modules.controller.js';
import { TenantModulesService } from './tenant-modules.service.js';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';

@Module({
  controllers: [
    PlatformAuthController,
    BusinessTypesController,
    TenantsController,
    TenantModulesController,
    DomainsController,
    CaddyController,
    ImpersonationController,
  ],
  providers: [
    PlatformAuthService,
    PlatformSessionService,
    BusinessTypesService,
    TenantsService,
    TenantModulesService,
    DomainsService,
    DomainRecheckJob,
    ImpersonationService,
    { provide: DNS_RESOLVER, useValue: systemDnsResolver },
  ],
})
export class PlatformModule {}
