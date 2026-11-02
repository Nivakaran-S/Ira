import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import type { AccessCheck } from '../access.guard.js';
import { routeRealm } from '../decorators.js';

@Injectable()
export class TenantStatusCheck implements AccessCheck {
  constructor(private readonly reflector: Reflector) {}

  check(ctx: ExecutionContext, req: RequestWithContext) {
    if (routeRealm(this.reflector, ctx) !== 'tenant') return;
    if (req.tenant?.status === 'SUSPENDED') throw new AppError('TENANT_SUSPENDED', 403, 'This account is suspended');
  }
}
