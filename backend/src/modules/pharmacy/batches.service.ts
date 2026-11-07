import { Injectable } from '@nestjs/common';
import { allocateFefo, type BatchTake, type ReceiveBatchSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { InventoryService } from '../inventory/inventory.service.js';

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Lots with expiry dates. Sales take first-expiring-first and never from an expired lot. */
@Injectable()
export class BatchesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  receive(tenant: TenantContext, ctx: ReturnType<typeof auditContext>, input: z.infer<typeof ReceiveBatchSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const product = await tx.product.findUnique({ where: { id: input.productId } });
      if (!product || !(await tx.store.findUnique({ where: { id: input.storeId } }))) throw AppError.notFound('Store or product not found');
      if (!product.tracksBatches) throw new AppError('INVALID_STATE', 409, 'This product does not track lots; switch it on in the catalog');
      const expiresOn = new Date(`${input.expiresOn}T00:00:00Z`);
      const existing = await tx.batch.findUnique({
        where: { tenantId_storeId_productId_lotNo: { tenantId: tenant.id, storeId: input.storeId, productId: input.productId, lotNo: input.lotNo } },
      });
      if (existing && day(existing.expiresOn) !== input.expiresOn) throw AppError.conflict('This lot number already exists with a different expiry date');
      const batch = existing
        ? await tx.batch.update({ where: { id: existing.id }, data: { qtyMilli: { increment: input.qtyMilli } } })
        : await tx.batch.create({ data: { tenantId: tenant.id, storeId: input.storeId, productId: input.productId, lotNo: input.lotNo, expiresOn, qtyMilli: input.qtyMilli } });
      await this.inventory.apply(tx, tenant.id, [{
        storeId: input.storeId, productId: input.productId, deltaMilli: input.qtyMilli, reason: 'RECEIVE', refType: 'Batch', refId: batch.id,
        note: input.note ?? `Lot ${input.lotNo}`, userId: ctx.actorUserId, batchId: batch.id,
      }]);
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'batch.received', entityType: 'Batch', entityId: batch.id, after: input });
      return batch;
    });
  }

  /** A store's lots, soonest expiry first, with expired and expiring-soon flags. */
  list(tenant: TenantContext, storeId: string, warnDays: number) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const lots = await tx.batch.findMany({ where: { storeId, qtyMilli: { gt: 0 } }, orderBy: [{ expiresOn: 'asc' }, { lotNo: 'asc' }] });
      const names = new Map((await tx.product.findMany({ where: { id: { in: [...new Set(lots.map((l) => l.productId))] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
      const today = day(new Date());
      const soon = day(new Date(Date.now() + warnDays * 86_400_000));
      return lots.map((l) => ({
        id: l.id, productId: l.productId, productName: names.get(l.productId) ?? '', lotNo: l.lotNo, expiresOn: day(l.expiresOn), qtyMilli: l.qtyMilli,
        expired: day(l.expiresOn) < today, expiringSoon: day(l.expiresOn) >= today && day(l.expiresOn) <= soon,
      }));
    });
  }

  /** Recall: every sale that took stock from this lot. */
  salesOf(tenant: TenantContext, batchId: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const batch = await tx.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw AppError.notFound('Lot not found');
      const filter = JSON.stringify([{ batchId }]);
      const rows = await tx.$queryRaw<{ saleId: string; receiptNo: string; soldAt: Date; customerId: string | null; name: string }[]>`
        SELECT s.id AS "saleId", s."receiptNo", s."soldAt", s."customerId", l.name
        FROM "SaleLine" l JOIN "Sale" s ON s.id = l."saleId"
        WHERE l.batches @> ${filter}::jsonb ORDER BY s."soldAt" DESC LIMIT 500`;
      return { lot: { id: batch.id, lotNo: batch.lotNo, expiresOn: day(batch.expiresOn) }, sales: rows };
    });
  }

  /** Takes stock for a sale line from the store's lots. Returns what came from where. */
  async take(tx: Tx, storeId: string, productId: string, qtyMilli: number): Promise<{ takes: BatchTake[]; short: number }> {
    const lots = (await tx.batch.findMany({ where: { storeId, productId, qtyMilli: { gt: 0 } } })).map((b) => ({
      id: b.id, lotNo: b.lotNo, expiresOn: day(b.expiresOn), qtyMilli: b.qtyMilli,
    }));
    const r = allocateFefo(lots, qtyMilli, day(new Date()));
    for (const t of r.takes) {
      const n = await tx.batch.updateMany({ where: { id: t.batchId, qtyMilli: { gte: t.qtyMilli } }, data: { qtyMilli: { decrement: t.qtyMilli } } });
      if (n.count !== 1) throw AppError.conflict('Stock in a lot changed meanwhile; try again');
    }
    return r;
  }

  /** Puts quantity back into the lots a line came from, latest-expiring first (voids, restocked refunds). */
  async giveBack(tx: Tx, takes: BatchTake[], qtyMilli: number): Promise<{ batchId: string; qtyMilli: number }[]> {
    const back: { batchId: string; qtyMilli: number }[] = [];
    let left = qtyMilli;
    for (const t of [...takes].sort((a, b) => (a.expiresOn < b.expiresOn ? 1 : -1))) {
      if (left <= 0) break;
      const q = Math.min(left, t.qtyMilli);
      await tx.batch.update({ where: { id: t.batchId }, data: { qtyMilli: { increment: q } } });
      back.push({ batchId: t.batchId, qtyMilli: q });
      left -= q;
    }
    return back;
  }
}
