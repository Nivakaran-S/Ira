import { Injectable } from '@nestjs/common';
import type { CreateRoleSchema } from '@pos/shared';
import type { z } from 'zod';
import type { Principal, TenantContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { assertCanGrant } from './grant-rules.js';

type Ctx = ReturnType<typeof auditContext>;

@Injectable()
export class RolesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly capabilities: CapabilitiesService,
    private readonly audit: AuditService,
  ) {}

  async create(tenant: TenantContext, principal: Principal, ctx: Ctx, input: z.infer<typeof CreateRoleSchema>) {
    assertCanGrant(await this.capabilities.permissionsFor(tenant.id, principal.userId), input.permissions);
    return this.tenantDb.run(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { tenantId: tenant.id, ...input, isSystem: false } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'role.created', entityType: 'Role', entityId: role.id, after: input });
      return role;
    });
  }

  list(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.role.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, permissions: true, requiresMfa: true, isSystem: true, _count: { select: { users: true } } },
      }),
    );
  }
}
