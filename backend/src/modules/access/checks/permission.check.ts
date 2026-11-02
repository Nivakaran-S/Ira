import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@pos/shared';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import type { AccessCheck } from '../access.guard.js';
import { CapabilitiesService } from '../capabilities.service.js';
import { PERMISSION_KEY, routeMeta } from '../decorators.js';

@Injectable()
export class PermissionCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly capabilities: CapabilitiesService,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    const required = routeMeta<Permission>(this.reflector, PERMISSION_KEY, ctx);
    if (!required) return;
    const p = req.principal;
    if (!p) throw AppError.unauthenticated();
    if (p.realm !== 'tenant' || !req.tenant) throw AppError.forbidden();
    const perms = await this.capabilities.permissionsFor(req.tenant.id, p.userId);
    if (!perms.has(required)) throw AppError.forbidden(`Missing permission ${required}`);
  }
}
