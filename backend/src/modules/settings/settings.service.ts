import { Injectable } from '@nestjs/common';
import { parseSettings, type TenantSettings } from '@pos/shared';
import { AppError } from '../../common/errors/app-error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';

export interface TenantProfile {
  settings: TenantSettings;
  currency: string;
  country: string;
  timezone: string;
  name: string;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async profile(tenantId: string): Promise<TenantProfile> {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true, currency: true, country: true, timezone: true, name: true } });
    if (!t) throw AppError.notFound('Tenant not found');
    return { settings: parseSettings(t.settings), currency: t.currency, country: t.country, timezone: t.timezone, name: t.name };
  }

  async get(tenantId: string): Promise<TenantSettings> {
    return (await this.profile(tenantId)).settings;
  }

  /** Replaces the known settings; keys this version does not know about (business-type defaults) are kept. */
  async update(tenantId: string, next: TenantSettings, ctx: ReturnType<typeof auditContext>): Promise<TenantSettings> {
    const t = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
    const before = parseSettings(t.settings);
    const raw = (t.settings && typeof t.settings === 'object' && !Array.isArray(t.settings) ? t.settings : {}) as Record<string, unknown>;
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { settings: { ...raw, ...next } as Prisma.InputJsonObject } });
    await this.tenantDb.run(tenantId, (tx) =>
      this.audit.record(tx, tenantId, { ...ctx, action: 'settings.updated', entityType: 'Tenant', entityId: tenantId, before, after: next }),
    );
    return next;
  }
}
