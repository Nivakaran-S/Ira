import { Inject, Injectable } from '@nestjs/common';
import type { ImpersonateSchema } from '@pos/shared';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { ENV, type Env } from '../../config/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { RevocationStore } from '../../security/revocation.store.js';
import { TokenService } from '../../security/token.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { OWNER_ROLE_NAME } from './tenants.service.js';

export const IMPERSONATION_TTL_SEC = 1800;
type Ctx = ReturnType<typeof platformAuditContext>;

@Injectable()
export class ImpersonationService {
  private readonly base: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly tokens: TokenService,
    private readonly revocations: RevocationStore,
    private readonly audit: AuditService,
    @Inject(ENV) env: Env,
  ) {
    this.base = env.PLATFORM_DOMAIN;
  }

  async start(tenantId: string, input: z.infer<typeof ImpersonateSchema>, ctx: Ctx) {
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
    if (!tenant) throw AppError.notFound('Tenant not found');
    if (tenant.status !== 'ACTIVE') throw AppError.conflict('Reactivate the tenant before impersonating');

    const sessionId = uuidv7();
    const target = await this.tenantDb.run(tenantId, async (tx) => {
      const user = input.userId
        ? await tx.user.findFirst({ where: { id: input.userId, status: 'ACTIVE' } })
        : await tx.user.findFirst({
            where: { status: 'ACTIVE', roles: { some: { role: { name: OWNER_ROLE_NAME, isSystem: true } } } },
            orderBy: { createdAt: 'asc' },
          });
      if (!user) throw AppError.notFound('User not found');
      await this.audit.record(tx, tenantId, {
        ip: ctx.ip, userAgent: ctx.userAgent, correlationId: ctx.correlationId,
        action: 'impersonation.started', entityType: 'User', entityId: user.id,
        actorUserId: user.id, impersonatorId: ctx.actorId, after: { reason: input.reason, sessionId },
      });
      await this.audit.recordPlatform(tx, {
        ...ctx, action: 'tenant.impersonation_started', entityType: 'Tenant', entityId: tenantId,
        after: { reason: input.reason, userId: user.id, sessionId },
      });
      return user;
    });

    const accessToken = await this.tokens.sign(
      'tenant',
      { sub: target.id, tid: tenantId, sid: sessionId, imp: ctx.actorId },
      IMPERSONATION_TTL_SEC,
    );
    return { accessToken, expiresIn: IMPERSONATION_TTL_SEC, sessionId, host: `${tenant.slug}.${this.base}`, userId: target.id };
  }

  async end(sessionId: string, ctx: Ctx) {
    await this.revocations.markRevoked(sessionId, IMPERSONATION_TTL_SEC);
    await this.prisma.$transaction((tx) =>
      this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.impersonation_ended', entityType: 'ImpersonationSession', entityId: sessionId }),
    );
  }
}
