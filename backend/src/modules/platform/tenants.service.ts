import { Inject, Injectable } from '@nestjs/common';
import { type CreateTenantSchema, PERMISSIONS, RoleTemplateSchema } from '@pos/shared';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { randomToken, sha256Hex } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import { ENV, type Env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import { TenantResolverService } from '../access/tenant-resolver.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

export const OWNER_ROLE_NAME = 'Owner';
export const OWNER_SETUP_TTL_MS = 7 * 24 * 3_600_000;

type Ctx = ReturnType<typeof platformAuditContext>;

const detailInclude = {
  businessType: { select: { id: true, key: true, name: true } },
  plan: { select: { id: true, key: true, name: true, maxStores: true, maxDevices: true, maxUsers: true } },
  domains: { select: { id: true, hostname: true, verifiedAt: true, lastCheckedAt: true } },
  moduleOverrides: { select: { moduleKey: true, enabled: true } },
} as const;

@Injectable()
export class TenantsService {
  private readonly base: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly resolver: TenantResolverService,
    private readonly capabilities: CapabilitiesService,
    private readonly audit: AuditService,
    @Inject(ENV) env: Env,
  ) {
    this.base = env.PLATFORM_DOMAIN;
  }

  private async addTemplateRoles(tx: Tx, tenantId: string, roleTemplates: unknown) {
    const templates = RoleTemplateSchema.array().parse(roleTemplates);
    const existing = new Set((await tx.role.findMany({ select: { name: true } })).map((r) => r.name));
    const missing = templates.filter((t) => !existing.has(t.name));
    if (missing.length) {
      await tx.role.createMany({
        data: missing.map((t) => ({ tenantId, name: t.name, permissions: t.permissions, requiresMfa: t.requiresMfa, isSystem: true })),
      });
    }
    return missing.map((t) => t.name);
  }

  async create(input: z.infer<typeof CreateTenantSchema>, ctx: Ctx) {
    const [bt, plan] = await Promise.all([
      this.prisma.businessType.findUnique({ where: { id: input.businessTypeId } }),
      this.prisma.plan.findUnique({ where: { key: input.planKey } }),
    ]);
    if (!bt) throw AppError.notFound('Business type not found');
    if (!plan) throw AppError.notFound('Plan not found');

    const id = uuidv7();
    const ownerSetupCode = randomToken(24);
    const owner = await this.tenantDb.run(id, async (tx) => {
      await tx.tenant.create({
        data: {
          id,
          name: input.name,
          slug: input.slug,
          businessTypeId: bt.id,
          planId: plan.id,
          country: input.country,
          currency: input.currency,
          timezone: input.timezone,
          settings: bt.defaultSettings as Prisma.InputJsonValue,
        },
      });
      const ownerRole = await tx.role.create({
        data: { tenantId: id, name: OWNER_ROLE_NAME, permissions: [...PERMISSIONS], requiresMfa: true, isSystem: true },
      });
      await this.addTemplateRoles(tx, id, bt.roleTemplates);
      const user = await tx.user.create({
        data: {
          tenantId: id,
          name: input.ownerName,
          email: input.ownerEmail,
          setupTokenHash: sha256Hex(ownerSetupCode),
          setupTokenExpiresAt: new Date(Date.now() + OWNER_SETUP_TTL_MS),
        },
      });
      await tx.userRole.create({ data: { tenantId: id, userId: user.id, roleId: ownerRole.id } });
      const summary = { slug: input.slug, businessType: bt.key, plan: plan.key, ownerEmail: input.ownerEmail };
      await this.audit.record(tx, id, {
        ip: ctx.ip, userAgent: ctx.userAgent, correlationId: ctx.correlationId,
        action: 'tenant.created', entityType: 'Tenant', entityId: id, after: { ...summary, bySuperAdmin: ctx.actorId },
      });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.created', entityType: 'Tenant', entityId: id, after: summary });
      return user;
    });

    // A lookup before creation may have cached this host as unknown.
    await this.resolver.invalidateHosts([`${input.slug}.${this.base}`]);
    return { tenant: await this.get(id), owner: { id: owner.id, email: owner.email }, ownerSetupCode, host: `${input.slug}.${this.base}` };
  }

  list() {
    return this.prisma.tenant.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, name: true, slug: true, status: true, country: true, currency: true, createdAt: true,
        businessType: { select: { key: true, name: true } },
        plan: { select: { key: true } },
      },
    });
  }

  async get(id: string) {
    const tenant = await this.prisma.tenant.findFirst({ where: { id, deletedAt: null }, include: detailInclude });
    if (!tenant) throw AppError.notFound('Tenant not found');
    return tenant;
  }

  async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED', ctx: Ctx) {
    const before = await this.get(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id }, data: { status } });
      await this.audit.recordPlatform(tx, {
        ...ctx, action: 'tenant.status_changed', entityType: 'Tenant', entityId: id, before: { status: before.status }, after: { status },
      });
    });
    await this.resolver.invalidateTenant(id);
    return this.get(id);
  }

  async changeBusinessType(id: string, businessTypeId: string, ctx: Ctx) {
    const before = await this.get(id);
    const bt = await this.prisma.businessType.findUnique({ where: { id: businessTypeId } });
    if (!bt) throw AppError.notFound('Business type not found');
    await this.tenantDb.run(id, async (tx) => {
      await tx.tenant.update({ where: { id }, data: { businessTypeId } });
      const added = await this.addTemplateRoles(tx, id, bt.roleTemplates);
      const change = { from: before.businessType.key, to: bt.key, rolesAdded: added };
      await this.audit.record(tx, id, {
        ip: ctx.ip, userAgent: ctx.userAgent, correlationId: ctx.correlationId,
        action: 'tenant.business_type_changed', entityType: 'Tenant', entityId: id, after: { ...change, bySuperAdmin: ctx.actorId },
      });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.business_type_changed', entityType: 'Tenant', entityId: id, after: change });
    });
    await Promise.all([this.resolver.invalidateTenant(id), this.capabilities.invalidateModules([id])]);
    return this.get(id);
  }

  async softDelete(id: string, ctx: Ctx) {
    await this.get(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id }, data: { deletedAt: new Date(), status: 'SUSPENDED' } });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.deleted', entityType: 'Tenant', entityId: id });
    });
    await this.resolver.invalidateTenant(id);
  }
}
