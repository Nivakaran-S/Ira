import { Inject, Injectable } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { HostRealm, RequestWithContext, TenantContext } from '../../common/request-context.js';
import { ENV, type Env } from '../../config/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { RedisService } from '../../infra/redis.service.js';

const CACHE_TTL_SEC = 60;
type Resolution = { realm: HostRealm; tenant?: TenantContext };

@Injectable()
export class TenantResolverService {
  private readonly base: string;

  constructor(
    @Inject(ENV) env: Env,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.base = env.PLATFORM_DOMAIN;
  }

  normaliseHost(raw: string | undefined): string {
    return (raw ?? '').trim().toLowerCase().replace(/:\d+$/, '');
  }

  async resolveHost(raw: string | undefined): Promise<Resolution> {
    const host = this.normaliseHost(raw);
    if (!host) return { realm: 'unknown' };
    if (host === `admin.${this.base}`) return { realm: 'platform' };

    const cached = await this.redis.client.get(`host:${host}`);
    if (cached) return cached === 'none' ? { realm: 'unknown' } : { realm: 'tenant', tenant: JSON.parse(cached) as TenantContext };

    const tenant = await this.lookup(host);
    await this.redis.client.set(`host:${host}`, tenant ? JSON.stringify(tenant) : 'none', 'EX', CACHE_TTL_SEC);
    return tenant ? { realm: 'tenant', tenant } : { realm: 'unknown' };
  }

  private async lookup(host: string): Promise<TenantContext | null> {
    const select = { id: true, name: true, slug: true, status: true, businessTypeId: true, planId: true, deletedAt: true } as const;
    let row: (TenantContext & { deletedAt: Date | null }) | null = null;
    if (host.endsWith(`.${this.base}`)) {
      const slug = host.slice(0, -(this.base.length + 1));
      if (slug && !slug.includes('.')) row = await this.prisma.tenant.findUnique({ where: { slug }, select });
    } else {
      const domain = await this.prisma.domain.findUnique({ where: { hostname: host }, select: { verifiedAt: true, tenant: { select } } });
      if (domain?.verifiedAt) row = domain.tenant;
    }
    if (!row || row.deletedAt) return null;
    const { deletedAt: _deleted, ...tenant } = row;
    return tenant;
  }

  async invalidateHosts(hosts: string[]): Promise<void> {
    if (hosts.length) await this.redis.client.del(...hosts.map((h) => `host:${this.normaliseHost(h)}`));
  }

  async invalidateTenant(tenantId: string): Promise<void> {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, domains: { select: { hostname: true } } } });
    if (t) await this.invalidateHosts([`${t.slug}.${this.base}`, ...t.domains.map((d) => d.hostname)]);
  }

  readonly middleware = async (req: RequestWithContext, res: Response, next: NextFunction) => {
    try {
      const r = await this.resolveHost(req.headers.host);
      req.hostRealm = r.realm;
      req.tenant = r.tenant;
      next();
    } catch {
      res.status(503).json({ code: 'INTERNAL', message: 'Service unavailable', correlationId: req.correlationId });
    }
  };
}
