import { Injectable } from '@nestjs/common';
import { applyOverrides, type ModuleOverride, missingDependencies, resolveModules } from '@pos/shared';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

type Ctx = ReturnType<typeof platformAuditContext>;

@Injectable()
export class TenantModulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly audit: AuditService,
  ) {}

  private async load(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, businessType: { select: { modules: true } }, moduleOverrides: { select: { moduleKey: true, enabled: true } } },
    });
    if (!tenant) throw AppError.notFound('Tenant not found');
    return { base: tenant.businessType.modules, overrides: tenant.moduleOverrides };
  }

  async get(tenantId: string) {
    const { base, overrides } = await this.load(tenantId);
    return { base, overrides, resolved: resolveModules(base, overrides) };
  }

  private assertSatisfiable(base: string[], overrides: ModuleOverride[]) {
    const missing = missingDependencies(applyOverrides(base, overrides));
    if (missing.length) throw AppError.conflict('Module dependencies not satisfied', missing);
  }

  async set(tenantId: string, input: { moduleKey: string; enabled: boolean }, ctx: Ctx) {
    const { base, overrides } = await this.load(tenantId);
    const candidate = [...overrides.filter((o) => o.moduleKey !== input.moduleKey), input];
    this.assertSatisfiable(base, candidate);
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantModule.upsert({
        where: { tenantId_moduleKey: { tenantId, moduleKey: input.moduleKey } },
        update: { enabled: input.enabled },
        create: { tenantId, moduleKey: input.moduleKey, enabled: input.enabled },
      });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.module_override_set', entityType: 'Tenant', entityId: tenantId, after: input });
    });
    await this.capabilities.invalidateModules([tenantId]);
    return this.get(tenantId);
  }

  async clear(tenantId: string, moduleKey: string, ctx: Ctx) {
    const { base, overrides } = await this.load(tenantId);
    this.assertSatisfiable(base, overrides.filter((o) => o.moduleKey !== moduleKey));
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantModule.deleteMany({ where: { tenantId, moduleKey } });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.module_override_cleared', entityType: 'Tenant', entityId: tenantId, after: { moduleKey } });
    });
    await this.capabilities.invalidateModules([tenantId]);
    return this.get(tenantId);
  }
}
