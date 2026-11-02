import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import { TenantDb } from '../../../infra/tenant-db.service.js';
import { RevocationStore } from '../../../security/revocation.store.js';
import { type AccessClaims, TokenService } from '../../../security/token.service.js';
import { auditContext } from '../../audit/audit-context.js';
import { AuditService } from '../../audit/audit.service.js';
import type { AccessCheck } from '../access.guard.js';
import { PUBLIC_KEY, routeMeta, routeRealm } from '../decorators.js';

@Injectable()
export class AuthCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly revocations: RevocationStore,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    if (routeMeta<boolean>(this.reflector, PUBLIC_KEY, ctx)) return;
    const realm = routeRealm(this.reflector, ctx);
    if (realm === 'any') throw AppError.unauthenticated(); // realm-any routes must be @Public

    const match = /^Bearer (\S+)$/.exec(req.header('authorization') ?? '');
    if (!match) throw AppError.unauthenticated();
    const claims = await this.tokens.verify<AccessClaims>(match[1], realm);
    if (claims.sid && (await this.revocations.isRevoked(claims.sid))) throw AppError.unauthenticated('Session revoked');

    if (realm === 'tenant' && claims.tid !== req.tenant!.id) {
      const tenantId = req.tenant!.id;
      await this.tenantDb.run(tenantId, (tx) =>
        this.audit.record(tx, tenantId, {
          ...auditContext(req),
          action: 'auth.tenant_mismatch',
          entityType: 'Tenant',
          entityId: tenantId,
          after: { tokenTenantId: claims.tid ?? null, tokenSubject: claims.sub },
        }),
      );
      throw new AppError('TENANT_MISMATCH', 403, 'Token is not valid for this tenant');
    }

    req.principal = {
      realm,
      userId: claims.sub,
      tenantId: claims.tid,
      sessionId: claims.sid,
      deviceId: claims.did,
      impersonatorId: claims.imp,
    };
  }
}
