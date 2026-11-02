import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { RequestWithContext } from '../../common/request-context.js';
import { RealmCheck } from './checks/realm.check.js';

export interface AccessCheck {
  check(ctx: ExecutionContext, req: RequestWithContext): Promise<void> | void;
}

/** The single global guard. Checks run in a fixed order; the first failure throws. */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly steps: AccessCheck[];

  constructor(realm: RealmCheck) {
    this.steps = [realm];
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    for (const step of this.steps) await step.check(ctx, req);
    return true;
  }
}
