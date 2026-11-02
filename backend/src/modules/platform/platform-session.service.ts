import { Injectable } from '@nestjs/common';
import { randomToken, sha256Hex } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { RevocationStore } from '../../security/revocation.store.js';
import { TokenService } from '../../security/token.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ACCESS_TTL_SEC, type IssuedSession, REFRESH_ABSOLUTE_MS, REFRESH_IDLE_MS } from '../identity/session.service.js';

@Injectable()
export class PlatformSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly revocations: RevocationStore,
    private readonly audit: AuditService,
  ) {}

  async start(tx: Tx, superAdminId: string): Promise<IssuedSession> {
    const family = await tx.platformRefreshFamily.create({
      data: { superAdminId, absoluteExpiresAt: new Date(Date.now() + REFRESH_ABSOLUTE_MS) },
    });
    return this.issue(tx, family.id, superAdminId);
  }

  private async issue(tx: Tx, familyId: string, superAdminId: string): Promise<IssuedSession> {
    const refreshToken = randomToken();
    await tx.platformRefreshToken.create({
      data: { familyId, tokenHash: sha256Hex(refreshToken), expiresAt: new Date(Date.now() + REFRESH_IDLE_MS) },
    });
    const accessToken = await this.tokens.sign('platform', { sub: superAdminId, sid: familyId }, ACCESS_TTL_SEC);
    return { accessToken, refreshToken, familyId };
  }

  async rotate(refreshToken: string): Promise<IssuedSession> {
    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const token = await tx.platformRefreshToken.findUnique({ where: { tokenHash: sha256Hex(refreshToken) }, include: { family: true } });
      if (!token || token.family.revokedAt || token.family.absoluteExpiresAt <= now || token.expiresAt <= now) {
        return { kind: 'invalid' as const };
      }
      const claimed = await tx.platformRefreshToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count === 0) {
        await tx.platformRefreshFamily.update({ where: { id: token.familyId }, data: { revokedAt: now } });
        await this.audit.recordPlatform(tx, {
          action: 'platform.auth.refresh_reuse',
          entityType: 'PlatformRefreshFamily',
          entityId: token.familyId,
          actorId: token.family.superAdminId,
        });
        return { kind: 'reuse' as const, familyId: token.familyId };
      }
      return { kind: 'ok' as const, session: await this.issue(tx, token.familyId, token.family.superAdminId) };
    });
    if (outcome.kind === 'reuse') await this.revocations.markRevoked(outcome.familyId, ACCESS_TTL_SEC);
    if (outcome.kind !== 'ok') throw AppError.unauthenticated('Session expired');
    return outcome.session;
  }

  async revoke(familyId: string): Promise<void> {
    await this.prisma.platformRefreshFamily.updateMany({ where: { id: familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.revocations.markRevoked(familyId, ACCESS_TTL_SEC);
  }
}
