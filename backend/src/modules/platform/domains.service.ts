import { resolveTxt } from 'node:dns/promises';
import { Inject, Injectable } from '@nestjs/common';
import { randomToken } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import { ENV, type Env } from '../../config/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { TenantResolverService } from '../access/tenant-resolver.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

export const DNS_RESOLVER = Symbol('DNS_RESOLVER');
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
}
export const systemDnsResolver: DnsResolver = { resolveTxt: (name) => resolveTxt(name) };

export const TXT_PREFIX = '_pos-verify';
type Ctx = ReturnType<typeof platformAuditContext>;
type DomainRow = { id: string; hostname: string; verificationToken: string; verifiedAt: Date | null; lastCheckedAt: Date | null };

@Injectable()
export class DomainsService {
  private readonly base: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: TenantResolverService,
    private readonly audit: AuditService,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(ENV) env: Env,
  ) {
    this.base = env.PLATFORM_DOMAIN;
  }

  private view(d: DomainRow) {
    return {
      id: d.id,
      hostname: d.hostname,
      verifiedAt: d.verifiedAt,
      lastCheckedAt: d.lastCheckedAt,
      txtName: `${TXT_PREFIX}.${d.hostname}`,
      txtValue: `pos-verify=${d.verificationToken}`,
    };
  }

  private async lookup(d: DomainRow): Promise<'present' | 'absent' | 'error'> {
    try {
      const records = await this.dns.resolveTxt(`${TXT_PREFIX}.${d.hostname}`);
      return records.map((chunks) => chunks.join('')).includes(`pos-verify=${d.verificationToken}`) ? 'present' : 'absent';
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOTFOUND' || code === 'ENODATA' ? 'absent' : 'error';
    }
  }

  private async findOwned(tenantId: string, domainId: string) {
    const d = await this.prisma.domain.findFirst({ where: { id: domainId, tenantId } });
    if (!d) throw AppError.notFound('Domain not found');
    return d;
  }

  async add(tenantId: string, hostname: string, ctx: Ctx) {
    if (hostname === this.base || hostname.endsWith(`.${this.base}`)) {
      throw AppError.validation([{ path: 'hostname', message: 'Platform subdomains are assigned automatically' }]);
    }
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
    if (!tenant) throw AppError.notFound('Tenant not found');
    const domain = await this.prisma.$transaction(async (tx) => {
      const d = await tx.domain.create({ data: { tenantId, hostname, verificationToken: randomToken(24) } });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'domain.added', entityType: 'Domain', entityId: d.id, after: { tenantId, hostname } });
      return d;
    });
    return this.view(domain);
  }

  async list(tenantId: string) {
    const rows = await this.prisma.domain.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
    return rows.map((d) => this.view(d));
  }

  async verify(tenantId: string, domainId: string, ctx: Ctx) {
    const d = await this.findOwned(tenantId, domainId);
    const result = await this.lookup(d);
    const now = new Date();
    if (result !== 'present') {
      const updated = await this.prisma.domain.update({ where: { id: d.id }, data: { lastCheckedAt: now } });
      return { ...this.view(updated), verified: false };
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.domain.update({ where: { id: d.id }, data: { verifiedAt: d.verifiedAt ?? now, lastCheckedAt: now } });
      if (!d.verifiedAt) {
        await this.audit.recordPlatform(tx, { ...ctx, action: 'domain.verified', entityType: 'Domain', entityId: d.id, after: { hostname: d.hostname } });
      }
      return row;
    });
    await this.resolver.invalidateHosts([d.hostname]);
    return { ...this.view(updated), verified: true };
  }

  async remove(tenantId: string, domainId: string, ctx: Ctx) {
    const d = await this.findOwned(tenantId, domainId);
    await this.prisma.$transaction(async (tx) => {
      await tx.domain.delete({ where: { id: d.id } });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'domain.removed', entityType: 'Domain', entityId: d.id, before: { hostname: d.hostname } });
    });
    await this.resolver.invalidateHosts([d.hostname]);
  }

  async recheckAll(): Promise<{ checked: number; unverified: number }> {
    const domains = await this.prisma.domain.findMany({ where: { verifiedAt: { not: null } } });
    let unverified = 0;
    for (const d of domains) {
      const result = await this.lookup(d);
      if (result === 'error') continue;
      if (result === 'present') {
        await this.prisma.domain.update({ where: { id: d.id }, data: { lastCheckedAt: new Date() } });
        continue;
      }
      unverified++;
      await this.prisma.$transaction(async (tx) => {
        await tx.domain.update({ where: { id: d.id }, data: { verifiedAt: null, lastCheckedAt: new Date() } });
        await this.audit.recordPlatform(tx, { action: 'domain.unverified', entityType: 'Domain', entityId: d.id, after: { hostname: d.hostname } });
      });
      await this.resolver.invalidateHosts([d.hostname]);
    }
    return { checked: domains.length, unverified };
  }
}
