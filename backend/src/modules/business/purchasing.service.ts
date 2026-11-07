import { Injectable } from '@nestjs/common';
import type { PurchaseOrderSchema, ReceivePurchaseSchema, SupplierSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { InventoryService } from '../inventory/inventory.service.js';

type Ctx = ReturnType<typeof auditContext>;

/** PO-000001, TR-000001: per-tenant, gap-free within a transaction. */
export async function nextNumber(tx: Tx, tenantId: string, key: string, prefix: string) {
  const c = await tx.tenantCounter.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, value: 1 },
    update: { value: { increment: 1 } },
  });
  return `${prefix}-${String(c.value).padStart(6, '0')}`;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

@Injectable()
export class PurchasingService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  // ── suppliers ──
  suppliers(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) => tx.supplier.findMany({ orderBy: { name: 'asc' } }));
  }

  createSupplier(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof SupplierSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const s = await tx.supplier.create({ data: { tenantId: tenant.id, ...input } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'supplier.created', entityType: 'Supplier', entityId: s.id, after: { name: input.name } });
      return s;
    });
  }

  // ── purchase orders ──
  list(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.purchaseOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { supplier: { select: { name: true } }, lines: true } }),
    );
  }

  get(tenant: TenantContext, id: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { supplier: { select: { name: true } }, lines: true } });
      if (!po) throw AppError.notFound('Purchase order not found');
      return { ...po, expectedOn: day(po.expectedOn) };
    });
  }

  create(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof PurchaseOrderSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const [supplier, store, products] = await Promise.all([
        tx.supplier.findUnique({ where: { id: input.supplierId } }),
        tx.store.findUnique({ where: { id: input.storeId } }),
        tx.product.count({ where: { id: { in: input.lines.map((l) => l.productId) }, hasVariants: false } }),
      ]);
      if (!supplier || !store) throw AppError.notFound('Supplier or store not found');
      if (products !== new Set(input.lines.map((l) => l.productId)).size) throw AppError.notFound('Product not found');
      const po = await tx.purchaseOrder.create({
        data: {
          tenantId: tenant.id, number: await nextNumber(tx, tenant.id, 'po', 'PO'), supplierId: input.supplierId, storeId: input.storeId,
          expectedOn: input.expectedOn ? new Date(`${input.expectedOn}T00:00:00Z`) : null, note: input.note ?? null, createdById: ctx.actorUserId!,
          lines: { create: input.lines.map((l) => ({ productId: l.productId, qtyMilli: l.qtyMilli, unitCost: l.unitCost })) },
        },
        include: { lines: true },
      });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'purchase_order.created', entityType: 'PurchaseOrder', entityId: po.id, after: { number: po.number, lines: input.lines.length } });
      return po;
    });
  }

  setStatus(tenant: TenantContext, ctx: Ctx, id: string, to: 'ORDERED' | 'CANCELLED') {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
      if (!po) throw AppError.notFound('Purchase order not found');
      if (to === 'ORDERED' && po.status !== 'DRAFT') throw new AppError('INVALID_STATE', 409, 'Only a draft can be sent to the supplier');
      if (to === 'CANCELLED' && (po.status === 'RECEIVED' || po.lines.some((l) => l.receivedQtyMilli > 0))) {
        throw new AppError('INVALID_STATE', 409, 'Goods were already received on this order');
      }
      const updated = await tx.purchaseOrder.update({
        where: { id }, data: { status: to, ...(to === 'ORDERED' ? { orderedAt: new Date() } : { closedAt: new Date() }) },
      });
      await this.audit.record(tx, tenant.id, { ...ctx, action: `purchase_order.${to.toLowerCase()}`, entityType: 'PurchaseOrder', entityId: id });
      return updated;
    });
  }

  /**
   * Goods in: stock rises at the order's store, lots are created for lot-tracked products, and each
   * product's cost becomes the price paid. Partial deliveries leave the order PARTIAL.
   */
  receive(tenant: TenantContext, ctx: Ctx, id: string, input: z.infer<typeof ReceivePurchaseSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const po = await tx.purchaseOrder.findUnique({ where: { id }, include: { lines: true } });
      if (!po) throw AppError.notFound('Purchase order not found');
      if (po.status !== 'ORDERED' && po.status !== 'PARTIAL') throw new AppError('INVALID_STATE', 409, 'Send the order before receiving goods');
      for (const r of input.lines) {
        const line = po.lines.find((l) => l.id === r.lineId);
        if (!line) throw AppError.notFound('Order line not found');
        if (line.receivedQtyMilli + r.qtyMilli > line.qtyMilli) throw new AppError('INVALID_STATE', 409, 'More than was ordered', { lineId: line.id });
        const product = await tx.product.findUniqueOrThrow({ where: { id: line.productId } });
        let batchId: string | null = null;
        if (product.tracksBatches) {
          if (!r.lotNo || !r.expiresOn) throw AppError.validation([{ path: 'lines', message: `${product.name} needs a lot number and expiry date` }]);
          const key = { tenantId_storeId_productId_lotNo: { tenantId: tenant.id, storeId: po.storeId, productId: product.id, lotNo: r.lotNo } };
          const existing = await tx.batch.findUnique({ where: key });
          if (existing && day(existing.expiresOn) !== r.expiresOn) throw AppError.conflict(`Lot ${r.lotNo} exists with a different expiry date`);
          batchId = existing
            ? (await tx.batch.update({ where: { id: existing.id }, data: { qtyMilli: { increment: r.qtyMilli } } })).id
            : (await tx.batch.create({
                data: { tenantId: tenant.id, storeId: po.storeId, productId: product.id, lotNo: r.lotNo, expiresOn: new Date(`${r.expiresOn}T00:00:00Z`), qtyMilli: r.qtyMilli },
              })).id;
        }
        await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { receivedQtyMilli: { increment: r.qtyMilli } } });
        await tx.product.update({ where: { id: product.id }, data: { costPrice: line.unitCost } });
        await this.inventory.apply(tx, tenant.id, [{
          storeId: po.storeId, productId: product.id, deltaMilli: r.qtyMilli, reason: 'RECEIVE', refType: 'PurchaseOrder', refId: po.id,
          note: po.number, userId: ctx.actorUserId, batchId,
        }]);
      }
      const lines = await tx.purchaseOrderLine.findMany({ where: { poId: id } });
      const done = lines.every((l) => l.receivedQtyMilli >= l.qtyMilli);
      const updated = await tx.purchaseOrder.update({ where: { id }, data: { status: done ? 'RECEIVED' : 'PARTIAL', ...(done ? { closedAt: new Date() } : {}) }, include: { lines: true } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'purchase_order.received', entityType: 'PurchaseOrder', entityId: id, after: { lines: input.lines.length, status: updated.status } });
      return updated;
    });
  }
}
