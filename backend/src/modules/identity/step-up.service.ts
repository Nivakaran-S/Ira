import { Injectable } from '@nestjs/common';
import type { Permission, StepUpSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { RateLimiter } from '../../infra/rate-limiter.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { PasswordService } from '../../security/password.service.js';
import { TokenService } from '../../security/token.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { LockoutService } from './lockout.service.js';

export const STEP_UP_TTL_SEC = 120;

export interface StepUpClaims {
  tid: string;
  did: string;
  act: Permission;
  /** The user the approval was granted to. */
  req: string;
}

@Injectable()
export class StepUpService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly lockout: LockoutService,
    private readonly capabilities: CapabilitiesService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
  ) {}

  async approve(
    tenant: TenantContext,
    device: { id: string },
    requesterUserId: string,
    input: z.infer<typeof StepUpSchema>,
    ctx: ReturnType<typeof auditContext>,
  ): Promise<{ stepUpToken: string; expiresIn: number }> {
    if (!(await this.limiter.consume(`stepup-dev:${device.id}`, 20, 900))) throw AppError.rateLimited();
    const approver = await this.tenantDb.run(tenant.id, (tx) =>
      tx.user.findFirst({ where: { id: input.approverUserId, status: 'ACTIVE' } }),
    );
    if (approver) this.lockout.assertNotLocked(approver.pinLockedUntil);
    const ok = await this.passwords.verify(approver?.pinHash, input.pin);
    if (!approver || !ok) {
      if (approver) await this.lockout.recordFailure(tenant.id, approver.id, 'pin', ctx);
      throw AppError.unauthenticated('Invalid approver PIN');
    }
    const perms = await this.capabilities.permissionsFor(tenant.id, approver.id);
    if (!perms.has(input.action)) throw AppError.forbidden(`Approver lacks ${input.action}`);

    await this.tenantDb.run(tenant.id, async (tx) => {
      await this.lockout.resetInTx(tx, approver.id, 'pin');
      await this.audit.record(tx, tenant.id, {
        ...ctx,
        action: 'auth.step_up_granted',
        entityType: 'User',
        entityId: approver.id,
        after: { action: input.action, approverUserId: approver.id, requesterUserId },
      });
    });
    const stepUpToken = await this.tokens.sign(
      'step-up',
      { sub: approver.id, tid: tenant.id, did: device.id, act: input.action, req: requesterUserId },
      STEP_UP_TTL_SEC,
    );
    return { stepUpToken, expiresIn: STEP_UP_TTL_SEC };
  }
}
