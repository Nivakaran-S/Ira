import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@pos/shared';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import { NonceStore } from '../../../security/nonce-store.js';
import { TokenService } from '../../../security/token.service.js';
import type { StepUpClaims } from '../../identity/step-up.service.js';
import type { AccessCheck } from '../access.guard.js';
import { routeMeta, STEP_UP_KEY } from '../decorators.js';

@Injectable()
export class StepUpCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly nonces: NonceStore,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    const action = routeMeta<Permission>(this.reflector, STEP_UP_KEY, ctx);
    if (!action) return;
    const required = () => new AppError('STEP_UP_REQUIRED', 403, 'Manager approval required', { action });
    const token = req.header('x-step-up-token');
    if (!token) throw required();
    let claims: StepUpClaims & { jti: string };
    try {
      claims = await this.tokens.verify<StepUpClaims>(token, 'step-up');
    } catch {
      throw required();
    }
    const matches =
      claims.act === action && claims.tid === req.tenant?.id && claims.did === req.device?.id && claims.req === req.principal?.userId;
    if (!matches) throw required();
    if (!(await this.nonces.claim(`stepup:${claims.jti}`, 300))) throw required();
  }
}
