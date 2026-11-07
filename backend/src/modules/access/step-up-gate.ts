import { Injectable } from '@nestjs/common';
import type { Permission } from '@pos/shared';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { NonceStore } from '../../security/nonce-store.js';
import { TokenService } from '../../security/token.service.js';
import type { StepUpClaims } from '../identity/step-up.service.js';

export const STEP_UP_HEADER = 'x-step-up-token';

/**
 * Manager approvals. A request may carry several step-up tokens (comma-separated), one per action;
 * each is single-use and bound to the tenant, the device and the requesting cashier.
 */
@Injectable()
export class StepUpGate {
  constructor(
    private readonly tokens: TokenService,
    private readonly nonces: NonceStore,
  ) {}

  /**
   * Staff holding `action` may act alone unless `force` (a threshold was crossed); anyone else needs a
   * manager approval for it. Returns the approver id, or null when no approval was needed.
   */
  async unlessPermitted(req: RequestWithContext, action: Permission, holds: boolean, force = false): Promise<string | null> {
    if (holds && !force) return null;
    return this.require(req, action);
  }

  /** Consumes the approval for `action` and returns the approving manager's user id. */
  async require(req: RequestWithContext, action: Permission): Promise<string> {
    const required = () => new AppError('STEP_UP_REQUIRED', 403, 'Manager approval required', { action });
    const header = req.header(STEP_UP_HEADER);
    if (!header) throw required();
    for (const token of header.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5)) {
      let claims: StepUpClaims & { jti: string; sub: string };
      try {
        claims = await this.tokens.verify<StepUpClaims>(token, 'step-up');
      } catch {
        continue;
      }
      const matches =
        claims.act === action && claims.tid === req.tenant?.id && claims.did === req.device?.id && claims.req === req.principal?.userId;
      if (!matches) continue;
      if (!(await this.nonces.claim(`stepup:${claims.jti}`, 300))) throw required();
      return claims.sub;
    }
    throw required();
  }
}
