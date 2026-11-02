import { Injectable } from '@nestjs/common';
import { randomToken, sha256Hex } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { RevocationStore } from '../../security/revocation.store.js';
import { TokenService } from '../../security/token.service.js';
import { AuditService } from '../audit/audit.service.js';

export const ACCESS_TTL_SEC = 300;
export const REFRESH_IDLE_MS = 12 * 3_600_000;
export const REFRESH_ABSOLUTE_MS = 7 * 24 * 3_600_000;

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  familyId: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly tokens: TokenService,
    private readonly revocations: RevocationStore,
    private readonly audit: AuditService,
  ) {}

  async start(tx: Tx, input: { tenantId: string; userId: string; deviceId?: string | null }): Promise<IssuedSession> {
    const family = await tx.refreshFamily.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        deviceId: input.deviceId ?? null,
        absoluteExpiresAt: new Date(Date.now() + REFRESH_ABSOLUTE_MS),
      },
    });
    return this.issue(tx, input.tenantId, family.id, input.userId, family.deviceId);
  }

  private async issue(tx: Tx, tenantId: string, familyId: string, userId: string, deviceId: string | null): Promise<IssuedSession> {
    const refreshToken = randomToken();
    await tx.refreshToken.create({
      data: { tenantId, familyId, tokenHash: sha256Hex(refreshToken), expiresAt: new Date(Date.now() + REFRESH_IDLE_MS) },
    });
    const accessToken = await this.tokens.sign(
      'tenant',
      { sub: userId, tid: tenantId, sid: familyId, ...(deviceId ? { did: deviceId } : {}) },
      ACCESS_TTL_SEC,
    );
    return { accessToken, refreshToken, familyId };
  }

  /**
   * deviceId: the verified device making the request (null if unsigned). A device-bound session can
   * only be refreshed by the same device, so a stolen till cookie is useless elsewhere.
   */
  async rotate(tenantId: string, refreshToken: string, deviceId: string | null = null): Promise<IssuedSession> {
    const now = new Date();
    const outcome = await this.tenantDb.run(tenantId, async (tx) => {
      const token = await tx.refreshToken.findUnique({ where: { tokenHash: sha256Hex(refreshToken) }, include: { family: true } });
      if (!token || token.family.revokedAt || token.family.absoluteExpiresAt <= now || token.expiresAt <= now) {
        return { kind: 'invalid' as const };
      }
      if (token.family.deviceId && token.family.deviceId !== deviceId) return { kind: 'invalid' as const };
      // Atomic claim: under concurrency only one caller flips usedAt; the other sees reuse.
      const claimed = await tx.refreshToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count === 0) {
        await tx.refreshFamily.update({ where: { id: token.familyId }, data: { revokedAt: now } });
        await this.audit.record(tx, tenantId, {
          action: 'auth.refresh_reuse',
          entityType: 'RefreshFamily',
          entityId: token.familyId,
          actorUserId: token.family.userId,
        });
        return { kind: 'reuse' as const, familyId: token.familyId };
      }
      const session = await this.issue(tx, tenantId, token.familyId, token.family.userId, token.family.deviceId);
      return { kind: 'ok' as const, session };
    });
    if (outcome.kind === 'reuse') await this.revocations.markRevoked(outcome.familyId, ACCESS_TTL_SEC);
    if (outcome.kind !== 'ok') throw AppError.unauthenticated('Session expired');
    return outcome.session;
  }

  async revoke(tenantId: string, familyId: string): Promise<void> {
    await this.tenantDb.run(tenantId, (tx) =>
      tx.refreshFamily.updateMany({ where: { id: familyId, revokedAt: null }, data: { revokedAt: new Date() } }),
    );
    await this.revocations.markRevoked(familyId, ACCESS_TTL_SEC);
  }

  /** Revokes matching live families inside the caller's tenant transaction. Caller must markRevoked the ids. */
  async revokeWhere(tx: Tx, where: { userId?: string; deviceId?: string }): Promise<string[]> {
    const families = await tx.refreshFamily.findMany({ where: { ...where, revokedAt: null }, select: { id: true } });
    if (families.length) {
      await tx.refreshFamily.updateMany({ where: { id: { in: families.map((f) => f.id) } }, data: { revokedAt: new Date() } });
    }
    return families.map((f) => f.id);
  }
}
