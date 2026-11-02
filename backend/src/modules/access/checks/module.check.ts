import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ModuleKey } from '@pos/shared';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import type { AccessCheck } from '../access.guard.js';
import { CapabilitiesService } from '../capabilities.service.js';
import { MODULE_KEY, routeMeta } from '../decorators.js';

@Injectable()
export class ModuleCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly capabilities: CapabilitiesService,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    const required = routeMeta<ModuleKey>(this.reflector, MODULE_KEY, ctx);
    if (!required) return;
    if (!req.tenant || !(await this.capabilities.modulesFor(req.tenant)).includes(required)) {
      throw new AppError('MODULE_DISABLED', 403, `Module ${required} is not enabled`, { module: required });
    }
  }
}
