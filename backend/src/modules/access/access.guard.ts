import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { RequestWithContext } from '../../common/request-context.js';
import { AuthCheck } from './checks/auth.check.js';
import { RealmCheck } from './checks/realm.check.js';
import { ModuleCheck } from './checks/module.check.js';
import { PermissionCheck } from './checks/permission.check.js';
import { TenantStatusCheck } from './checks/tenant-status.check.js';
import { DeviceCheck } from './checks/device.check.js';
import { StepUpCheck } from './checks/step-up.check.js';

export interface AccessCheck {
  check(ctx: ExecutionContext, req: RequestWithContext): Promise<void> | void;
}

/** The single global guard. Checks run in a fixed order; the first failure throws. */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly steps: AccessCheck[];

  constructor(
    realm: RealmCheck,
    tenantStatus: TenantStatusCheck,
    auth: AuthCheck,
    device: DeviceCheck,
    modules: ModuleCheck,
    permissions: PermissionCheck,
    stepUp: StepUpCheck,
  ) {
    this.steps = [realm, tenantStatus, auth, device, modules, permissions, stepUp];
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    for (const step of this.steps) await step.check(ctx, req);
    return true;
  }
}
