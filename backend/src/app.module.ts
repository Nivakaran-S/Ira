import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AppErrorFilter } from './common/errors/app-error.filter.js';
import { ConfigModule } from './config/env.js';
import { InfraModule } from './infra/infra.module.js';
import { AccessModule } from './modules/access/access.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { BackofficeModule } from './modules/backoffice/backoffice.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { SecurityModule } from './security/security.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { ReportingModule } from './modules/reporting/reporting.module.js';
import { SyncModule } from './modules/sync/sync.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { PromotionsModule } from './modules/promotions/promotions.module.js';
import { ModifiersModule } from './modules/restaurant/modifiers.module.js';
import { RestaurantModule } from './modules/restaurant/restaurant.module.js';

@Module({
  imports: [ScheduleModule.forRoot(), ConfigModule, InfraModule, SecurityModule, AuditModule, AccessModule, IdentityModule, BackofficeModule, PlatformModule,
    SettingsModule, CatalogModule, InventoryModule, SalesModule, ReportingModule, SyncModule, CustomersModule, PromotionsModule, ModifiersModule, RestaurantModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AppErrorFilter }],
})
export class AppModule {}
