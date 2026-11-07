import { Injectable } from '@nestjs/common';
import type { StockAdjustSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import type { StockReason } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

export interface StockChange {
  storeId: string;
  productId: string;
  deltaMilli: number;
  reason: StockReason;
  refType?: string;
  refId?: string;
  note?: string;
  userId?: string | null;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /**
   * Records movements and moves the denormalised levels, inside the caller's transaction. Stock may
   * go negative: a completed sale is a fact, and negative levels are surfaced to managers instead.
   */
  async apply(tx: Tx, tenantId: string, changes: StockChange[]): Promise<void> {
    for (const c of changes) {
      if (c.deltaMilli === 0) continue;
      await tx.stockMovement.create({
        data: {
          tenantId, storeId: c.storeId, productId: c.productId, deltaMilli: c.deltaMilli, reason: c.reason,
          refType: c.refType ?? null, refId: c.refId ?? null, note: c.note ?? null, userId: c.userId ?? null,
        },
      });
      await tx.stockLevel.upsert({
        where: { storeId_productId: { storeId: c.storeId, productId: c.productId } },
        create: { tenantId, storeId: c.storeId, productId: c.productId, qtyMilli: c.deltaMilli },
        update: { qtyMilli: { increment: c.deltaMilli } },
      });
    }
  }

  levels(tenant: TenantContext, storeId: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const [products, levels] = await Promise.all([
        tx.product.findMany({ where: { trackStock: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, sku: true, active: true } }),
        tx.stockLevel.findMany({ where: { storeId }, select: { productId: true, qtyMilli: true, updatedAt: true } }),
      ]);
      const byProduct = new Map(levels.map((l) => [l.productId, l]));
      return products.map((p) => ({ ...p, qtyMilli: byProduct.get(p.id)?.qtyMilli ?? 0, updatedAt: byProduct.get(p.id)?.updatedAt ?? null }));
    });
  }

  movements(tenant: TenantContext, productId: string, storeId?: string) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.stockMovement.findMany({ where: { productId, ...(storeId ? { storeId } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 }),
    );
  }

  adjust(tenant: TenantContext, ctx: ReturnType<typeof auditContext>, input: z.infer<typeof StockAdjustSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const [store, product] = await Promise.all([
        tx.store.findUnique({ where: { id: input.storeId } }),
        tx.product.findUnique({ where: { id: input.productId } }),
      ]);
      if (!store || !product) throw AppError.notFound('Store or product not found');
      await this.apply(tx, tenant.id, [
        { storeId: input.storeId, productId: input.productId, deltaMilli: input.deltaMilli, reason: 'ADJUSTMENT', note: input.note, userId: ctx.actorUserId },
      ]);
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'stock.adjusted', entityType: 'Product', entityId: product.id, after: input });
      const level = await tx.stockLevel.findUniqueOrThrow({ where: { storeId_productId: { storeId: input.storeId, productId: input.productId } } });
      return { productId: product.id, storeId: store.id, qtyMilli: level.qtyMilli };
    });
  }
}
