import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { RequestWithContext } from '../../common/request-context.js';
import { AuthCheck } from './checks/auth.check.js';
import { RealmCheck } from './checks/realm.check.js';
import { ModuleCheck } from './checks/module.check.js';
import { PermissionCheck } from './checks/permission.check.js';
import { TenantStatusCheck } from './checks/tenant-status.check.js';

export interface AccessCheck {
  check(ctx: ExecutionContext, req: RequestWithContext): Promise<void> | void;
}

/** The single global guard. Checks run in a fixed order; the first failure throws. */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly steps: AccessCheck[];

  constructor(realm: RealmCheck, tenantStatus: TenantStatusCheck, auth: AuthCheck, modules: ModuleCheck, permissions: PermissionCheck) {
    this.steps = [realm, tenantStatus, auth, modules, permissions];
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    for (const step of this.steps) await step.check(ctx, req);
    return true;
  }
}
