import { Module } from '@nestjs/common';
import { BillingWebhookController, PlatformBillingController, SandboxCheckoutController, TenantBillingController } from './billing.controller.js';
import { ENV, type Env } from '../../config/env.js';
import { BillingService } from './billing.service.js';
import { BILLING_GATEWAY } from './payments/billing-gateway.js';
import { PayHereGateway } from './payments/payhere-gateway.js';
import { SandboxGateway } from './payments/sandbox-gateway.js';
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

function billingGateway(env: Env) {
  switch (env.BILLING_GATEWAY) {
    case 'sandbox':
      return new SandboxGateway();
    case 'payhere':
      return new PayHereGateway({
        merchantId: env.PAYHERE_MERCHANT_ID!, merchantSecret: env.PAYHERE_MERCHANT_SECRET!, sandbox: env.PAYHERE_SANDBOX, notifyUrl: env.PAYHERE_NOTIFY_URL!,
      });
    default:
      return null;
  }
}

@Module({
  controllers: [
    PlatformAuthController,
    BusinessTypesController,
    TenantsController,
    TenantModulesController,
    DomainsController,
    CaddyController,
    ImpersonationController,
    PlatformBillingController,
    TenantBillingController,
    BillingWebhookController,
    SandboxCheckoutController,
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
    BillingService,
    { provide: DNS_RESOLVER, useValue: systemDnsResolver },
    { provide: BILLING_GATEWAY, inject: [ENV], useFactory: billingGateway },
  ],
})
export class PlatformModule {}
