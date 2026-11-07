import { Injectable } from '@nestjs/common';
import type { PromotionDef, PromotionSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

type Ctx = ReturnType<typeof auditContext>;
type Input = z.infer<typeof PromotionSchema>;
type Row = Prisma.PromotionGetPayload<object>;

/** A stored promotion in the shape the shared engine takes. */
export function toDef(r: Row): PromotionDef & { version: string } {
  return {
    id: r.id, name: r.name, kind: r.kind, productIds: r.productIds, categoryIds: r.categoryIds, active: r.active,
    startsAt: r.startsAt?.toISOString() ?? null, endsAt: r.endsAt?.toISOString() ?? null,
    ...(r.percentBp !== null ? { percentBp: r.percentBp } : {}),
    ...(r.amount !== null ? { amount: r.amount } : {}),
    ...(r.buyQty !== null ? { buyQty: r.buyQty } : {}),
    ...(r.getQty !== null ? { getQty: r.getQty } : {}),
    ...(r.getPercentBp !== null ? { getPercentBp: r.getPercentBp } : {}),
    ...(r.minSpend !== null ? { minSpend: r.minSpend } : {}),
    version: r.version.toString(),
  };
}

const data = (i: Input) => ({
  name: i.name, kind: i.kind, productIds: i.productIds, categoryIds: i.categoryIds, active: i.active,
  startsAt: i.startsAt ? new Date(i.startsAt) : null, endsAt: i.endsAt ? new Date(i.endsAt) : null,
  percentBp: i.percentBp ?? null, amount: i.amount ?? null, buyQty: i.buyQty ?? null, getQty: i.getQty ?? null,
  getPercentBp: i.getPercentBp ?? null, minSpend: i.minSpend ?? null,
});

@Injectable()
export class PromotionsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** Active promotions; the engine applies dates itself. */
  async live(tx: Tx): Promise<(PromotionDef & { version: string })[]> {
    return (await tx.promotion.findMany({ where: { active: true } })).map(toDef);
  }

  list(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, async (tx) => (await tx.promotion.findMany({ orderBy: { createdAt: 'desc' } })).map(toDef));
  }

  create(tenant: TenantContext, ctx: Ctx, input: Input) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const r = await tx.promotion.create({ data: { tenantId: tenant.id, ...data(input) } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'promotion.created', entityType: 'Promotion', entityId: r.id, after: input });
      return toDef(r);
    });
  }

  update(tenant: TenantContext, ctx: Ctx, id: string, input: Input) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const before = await tx.promotion.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Promotion not found');
      const r = await tx.promotion.update({ where: { id }, data: data(input) });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'promotion.updated', entityType: 'Promotion', entityId: id, before: toDef(before), after: input });
      return toDef(r);
    });
  }
}
