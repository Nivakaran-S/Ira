import { Injectable } from '@nestjs/common';
import type { ModifierGroupDef, ModifierGroupSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

type Ctx = ReturnType<typeof auditContext>;
const groupInclude = { options: { orderBy: { position: 'asc' } } } as const satisfies Prisma.ModifierGroupInclude;
type GroupRow = Prisma.ModifierGroupGetPayload<{ include: typeof groupInclude }>;

export function toGroupDef(g: GroupRow): ModifierGroupDef & { version: string } {
  return {
    id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, version: g.version.toString(),
    options: g.options.map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta, active: o.active })),
  };
}

@Injectable()
export class ModifiersService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  list(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, async (tx) => (await tx.modifierGroup.findMany({ orderBy: { name: 'asc' }, include: groupInclude })).map(toGroupDef));
  }

  /** Creates or replaces a group. Options removed from the list are switched off, not deleted: past sales name them. */
  save(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof ModifierGroupSchema>, id?: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const group = id
        ? await tx.modifierGroup.update({ where: { id }, data: { name: input.name, minSelect: input.minSelect, maxSelect: input.maxSelect } }).catch(() => {
            throw AppError.notFound('Modifier group not found');
          })
        : await tx.modifierGroup.create({ data: { tenantId: tenant.id, name: input.name, minSelect: input.minSelect, maxSelect: input.maxSelect } });
      const existing = await tx.modifier.findMany({ where: { groupId: group.id } });
      const keep = new Set<string>();
      for (const [position, o] of input.options.entries()) {
        if (o.id) {
          if (!existing.some((e) => e.id === o.id)) throw AppError.notFound('Modifier not found in this group');
          await tx.modifier.update({ where: { id: o.id }, data: { name: o.name, priceDelta: o.priceDelta, active: o.active, position } });
          keep.add(o.id);
        } else {
          await tx.modifier.create({ data: { tenantId: tenant.id, groupId: group.id, name: o.name, priceDelta: o.priceDelta, active: o.active, position } });
        }
      }
      const dropped = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
      if (dropped.length) await tx.modifier.updateMany({ where: { id: { in: dropped } }, data: { active: false } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: id ? 'modifier_group.updated' : 'modifier_group.created', entityType: 'ModifierGroup', entityId: group.id, after: input });
      return toGroupDef(await tx.modifierGroup.findUniqueOrThrow({ where: { id: group.id }, include: groupInclude }));
    });
  }

  setProductGroups(tenant: TenantContext, ctx: Ctx, productId: string, groupIds: string[]) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      if (!(await tx.product.findUnique({ where: { id: productId } }))) throw AppError.notFound('Product not found');
      const ids = [...new Set(groupIds)];
      if ((await tx.modifierGroup.count({ where: { id: { in: ids } } })) !== ids.length) throw AppError.notFound('Modifier group not found');
      await tx.productModifierGroup.deleteMany({ where: { productId } });
      if (ids.length) await tx.productModifierGroup.createMany({ data: ids.map((groupId, position) => ({ tenantId: tenant.id, productId, groupId, position })) });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'product.modifiers_set', entityType: 'Product', entityId: productId, after: { groupIds: ids } });
      return { groupIds: ids };
    });
  }

  /** Each product's modifier groups, in order. */
  async forProducts(tx: Tx, productIds: string[]): Promise<Map<string, (ModifierGroupDef & { version: bigint })[]>> {
    const links = await tx.productModifierGroup.findMany({
      where: { productId: { in: productIds } },
      orderBy: { position: 'asc' },
      include: { group: { include: groupInclude } },
    });
    const out = new Map<string, (ModifierGroupDef & { version: bigint })[]>();
    for (const l of links) {
      const list = out.get(l.productId) ?? [];
      list.push({ ...toGroupDef(l.group), version: l.group.version });
      out.set(l.productId, list);
    }
    return out;
  }
}
