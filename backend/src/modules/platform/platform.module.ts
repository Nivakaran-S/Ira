import { Module } from '@nestjs/common';
import { BusinessTypesController } from './business-types.controller.js';
import { BusinessTypesService } from './business-types.service.js';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformSessionService } from './platform-session.service.js';
import { TenantModulesController } from './tenant-modules.controller.js';
import { TenantModulesService } from './tenant-modules.service.js';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';

@Module({
  controllers: [PlatformAuthController, BusinessTypesController, TenantModulesController, TenantsController],
  providers: [PlatformAuthService, PlatformSessionService, BusinessTypesService, TenantModulesService, TenantsService],
})
export class PlatformModule {}
