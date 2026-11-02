import { Injectable } from '@nestjs/common';
import { type ModuleKey, PERMISSIONS, type Permission, resolveModules } from '@pos/shared';
import type { TenantContext } from '../../common/request-context.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { RedisService } from '../../infra/redis.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';

const MODULE_CACHE_TTL_SEC = 60;
const VALID_PERMISSIONS = new Set<string>(PERMISSIONS);

@Injectable()
export class CapabilitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly redis: RedisService,
  ) {}

  async modulesFor(tenant: Pick<TenantContext, 'id' | 'businessTypeId'>): Promise<ModuleKey[]> {
    const key = `mods:${tenant.id}`;
    const cached = await this.redis.client.get(key);
    if (cached) return JSON.parse(cached) as ModuleKey[];
    const [bt, overrides] = await Promise.all([
      this.prisma.businessType.findUniqueOrThrow({ where: { id: tenant.businessTypeId }, select: { modules: true } }),
      this.prisma.tenantModule.findMany({ where: { tenantId: tenant.id }, select: { moduleKey: true, enabled: true } }),
    ]);
    const modules = resolveModules(bt.modules, overrides);
    await this.redis.client.set(key, JSON.stringify(modules), 'EX', MODULE_CACHE_TTL_SEC);
    return modules;
  }

  async invalidateModules(tenantIds: string[]): Promise<void> {
    if (tenantIds.length) await this.redis.client.del(...tenantIds.map((id) => `mods:${id}`));
  }

  /** Read on every check so role changes and disabling a user take effect immediately. */
  async permissionsFor(tenantId: string, userId: string): Promise<Set<Permission>> {
    const user = await this.tenantDb.run(tenantId, (tx) =>
      tx.user.findFirst({
        where: { id: userId, status: 'ACTIVE' },
        select: { roles: { select: { role: { select: { permissions: true } } } } },
      }),
    );
    const all = user?.roles.flatMap((r) => r.role.permissions) ?? [];
    return new Set(all.filter((p): p is Permission => VALID_PERMISSIONS.has(p)));
  }
}
