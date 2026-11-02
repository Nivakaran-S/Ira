import { Injectable } from '@nestjs/common';
import type { CreateRegisterSchema, CreateStoreSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { PlanLimitsService } from '../access/plan-limits.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

type Ctx = ReturnType<typeof auditContext>;

@Injectable()
export class OrgService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly limits: PlanLimitsService,
    private readonly audit: AuditService,
  ) {}

  createStore(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof CreateStoreSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      await this.limits.assertCanAdd(tx, tenant, 'stores');
      const store = await tx.store.create({ data: { tenantId: tenant.id, ...input } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'store.created', entityType: 'Store', entityId: store.id, after: input });
      return store;
    });
  }

  listStores(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) => tx.store.findMany({ orderBy: { code: 'asc' } }));
  }

  createRegister(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof CreateRegisterSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const store = await tx.store.findUnique({ where: { id: input.storeId } });
      if (!store) throw AppError.notFound('Store not found');
      const register = await tx.register.create({ data: { tenantId: tenant.id, ...input } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'register.created', entityType: 'Register', entityId: register.id, after: input });
      return register;
    });
  }

  listRegisters(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) => tx.register.findMany({ orderBy: { code: 'asc' } }));
  }
}
