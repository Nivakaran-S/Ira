import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { type AuditEntry, AuditService } from '../audit/audit.service.js';

export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

export type CredentialKind = 'password' | 'pin';

@Injectable()
export class LockoutService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  assertNotLocked(lockedUntil: Date | null) {
    if (lockedUntil && lockedUntil > new Date()) throw new AppError('ACCOUNT_LOCKED', 423, 'Account temporarily locked');
  }

  /** Counts a failure in its own transaction (it must survive the request failing). */
  async recordFailure(tenantId: string, userId: string, kind: CredentialKind, entry: Partial<AuditEntry> = {}) {
    await this.tenantDb.run(tenantId, async (tx) => {
      const user =
        kind === 'password'
          ? await tx.user.update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } } })
          : await tx.user.update({ where: { id: userId }, data: { pinFailedCount: { increment: 1 } } });
      const count = kind === 'password' ? user.failedLoginCount : user.pinFailedCount;
      if (count >= MAX_FAILURES) {
        const until = new Date(Date.now() + LOCK_MS);
        await tx.user.update({
          where: { id: userId },
          data: kind === 'password' ? { failedLoginCount: 0, lockedUntil: until } : { pinFailedCount: 0, pinLockedUntil: until },
        });
      }
      await this.audit.record(tx, tenantId, { ...entry, action: `auth.${kind}_failed`, entityType: 'User', entityId: userId });
    });
  }

  async resetInTx(tx: Tx, userId: string, kind: CredentialKind) {
    await tx.user.update({
      where: { id: userId },
      data: kind === 'password' ? { failedLoginCount: 0, lockedUntil: null } : { pinFailedCount: 0, pinLockedUntil: null },
    });
  }
}
