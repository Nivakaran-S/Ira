import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@pos/shared';
import type { RequestWithContext } from '../../../common/request-context.js';
import type { AccessCheck } from '../access.guard.js';
import { routeMeta, STEP_UP_KEY } from '../decorators.js';
import { StepUpGate } from '../step-up-gate.js';

/** Routes that always need a manager approval. Conditional approvals call StepUpGate directly. */
@Injectable()
export class StepUpCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly gate: StepUpGate,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    const action = routeMeta<Permission>(this.reflector, STEP_UP_KEY, ctx);
    if (!action) return;
    req.stepUpApprovals = { ...req.stepUpApprovals, [action]: await this.gate.require(req, action) };
  }
}
