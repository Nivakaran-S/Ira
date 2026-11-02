import { Injectable } from '@nestjs/common';
import type { BusinessTypeSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

type Input = z.infer<typeof BusinessTypeSchema>;
type Ctx = ReturnType<typeof platformAuditContext>;

const toData = (input: Input) => ({
  key: input.key,
  name: input.name,
  description: input.description ?? null,
  modules: input.modules,
  roleTemplates: input.roleTemplates as Prisma.InputJsonArray,
  defaultSettings: input.defaultSettings as Prisma.InputJsonObject,
});

@Injectable()
export class BusinessTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.businessType.findMany({ orderBy: { name: 'asc' } });
  }

  create(input: Input, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      const bt = await tx.businessType.create({ data: toData(input) });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'business_type.created', entityType: 'BusinessType', entityId: bt.id, after: bt });
      return bt;
    });
  }

  async update(id: string, input: Input, ctx: Ctx) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.businessType.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Business type not found');
      const bt = await tx.businessType.update({ where: { id }, data: toData(input) });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'business_type.updated', entityType: 'BusinessType', entityId: id, before, after: bt });
      return bt;
    });
    const tenants = await this.prisma.tenant.findMany({ where: { businessTypeId: id }, select: { id: true } });
    await this.capabilities.invalidateModules(tenants.map((t) => t.id));
    return updated;
  }
}
