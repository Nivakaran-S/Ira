import { Injectable } from '@nestjs/common';
import type { BatchTake, ReceiveTransferSchema, StorePricesSchema, TransferSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { BatchesService } from '../pharmacy/batches.service.js';
import { nextNumber } from './purchasing.service.js';

type Ctx = ReturnType<typeof auditContext>;

@Injectable()
export class TransfersService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly inventory: InventoryService,
    private readonly batches: BatchesService,
    private readonly audit: AuditService,
  ) {}

  list(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) => tx.stockTransfer.findMany({ orderBy: { sentAt: 'desc' }, take: 200, include: { lines: true } }));
  }

  /** Sends stock: it leaves the source store now (lots first-expiring-first) and is in transit until received. */
  send(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof TransferSchema>) {
    if (input.fromStoreId === input.toStoreId) throw AppError.validation([{ path: 'toStoreId', message: 'Choose a different store' }]);
    return this.tenantDb.run(tenant.id, async (tx) => {
      if ((await tx.store.count({ where: { id: { in: [input.fromStoreId, input.toStoreId] } } })) !== 2) throw AppError.notFound('Store not found');
      const products = await tx.product.findMany({ where: { id: { in: input.lines.map((l) => l.productId) } } });
      const byId = new Map(products.map((p) => [p.id, p]));
      const lines: { productId: string; qtyMilli: number; batches: BatchTake[] }[] = [];
      for (const l of input.lines) {
        const p = byId.get(l.productId);
        if (!p || p.hasVariants) throw AppError.notFound('Product not found');
        const takes = p.tracksBatches ? (await this.batches.take(tx, input.fromStoreId, p.id, l.qtyMilli)).takes : [];
        lines.push({ productId: p.id, qtyMilli: l.qtyMilli, batches: takes });
      }
      const t = await tx.stockTransfer.create({
        data: {
          tenantId: tenant.id, number: await nextNumber(tx, tenant.id, 'transfer', 'TR'), fromStoreId: input.fromStoreId, toStoreId: input.toStoreId,
          note: input.note ?? null, sentById: ctx.actorUserId!,
          lines: { create: lines.map((l) => ({ productId: l.productId, qtyMilli: l.qtyMilli, batches: l.batches as unknown as Prisma.InputJsonValue })) },
        },
        include: { lines: true },
      });
      await this.inventory.apply(
        tx, tenant.id,
        lines.map((l) => ({ storeId: input.fromStoreId, productId: l.productId, deltaMilli: -l.qtyMilli, reason: 'TRANSFER_OUT' as const, refType: 'StockTransfer', refId: t.id, note: t.number, userId: ctx.actorUserId })),
      );
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'transfer.sent', entityType: 'StockTransfer', entityId: t.id, after: { number: t.number, lines: lines.length } });
      return t;
    });
  }

  /**
   * Receives at the destination. What arrived may differ from what was sent; the difference is
   * recorded on the line (and in the audit log) and does not reach the destination's stock.
   */
  receive(tenant: TenantContext, ctx: Ctx, id: string, input: z.infer<typeof ReceiveTransferSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const t = await tx.stockTransfer.findUnique({ where: { id }, include: { lines: true } });
      if (!t) throw AppError.notFound('Transfer not found');
      if (t.status !== 'SENT') throw new AppError('INVALID_STATE', 409, 'This transfer is not in transit');
      const discrepancies: { lineId: string; sent: number; received: number }[] = [];
      for (const line of t.lines) {
        const got = input.lines.find((l) => l.lineId === line.id)?.receivedQtyMilli ?? line.qtyMilli;
        if (got > line.qtyMilli) throw new AppError('INVALID_STATE', 409, 'More received than was sent', { lineId: line.id });
        if (got !== line.qtyMilli) discrepancies.push({ lineId: line.id, sent: line.qtyMilli, received: got });
        await tx.transferLine.update({ where: { id: line.id }, data: { receivedQtyMilli: got } });
        // Lots travel with the goods: recreate them at the destination, earliest-expiring first.
        let left = got;
        const movements: { batchId: string | null; qty: number }[] = [];
        for (const take of (line.batches as unknown as BatchTake[]) ?? []) {
          if (left <= 0) break;
          const q = Math.min(left, take.qtyMilli);
          const key = { tenantId_storeId_productId_lotNo: { tenantId: tenant.id, storeId: t.toStoreId, productId: line.productId, lotNo: take.lotNo } };
          const existing = await tx.batch.findUnique({ where: key });
          const batch = existing
            ? await tx.batch.update({ where: { id: existing.id }, data: { qtyMilli: { increment: q } } })
            : await tx.batch.create({ data: { tenantId: tenant.id, storeId: t.toStoreId, productId: line.productId, lotNo: take.lotNo, expiresOn: new Date(`${take.expiresOn}T00:00:00Z`), qtyMilli: q } });
          movements.push({ batchId: batch.id, qty: q });
          left -= q;
        }
        if (left > 0) movements.push({ batchId: null, qty: left });
        await this.inventory.apply(
          tx, tenant.id,
          movements.map((m) => ({
            storeId: t.toStoreId, productId: line.productId, deltaMilli: m.qty, reason: 'TRANSFER_IN' as const, refType: 'StockTransfer', refId: t.id, note: t.number,
            userId: ctx.actorUserId, batchId: m.batchId,
          })),
        );
      }
      const updated = await tx.stockTransfer.update({ where: { id }, data: { status: 'RECEIVED', receivedAt: new Date(), receivedById: ctx.actorUserId }, include: { lines: true } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'transfer.received', entityType: 'StockTransfer', entityId: id, after: { number: t.number, discrepancies } });
      return updated;
    });
  }

  /** Cancelling an in-transit transfer puts the stock (and lots) back at the source. */
  cancel(tenant: TenantContext, ctx: Ctx, id: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const t = await tx.stockTransfer.findUnique({ where: { id }, include: { lines: true } });
      if (!t) throw AppError.notFound('Transfer not found');
      if (t.status !== 'SENT') throw new AppError('INVALID_STATE', 409, 'Only a transfer in transit can be cancelled');
      for (const line of t.lines) {
        const takes = (line.batches as unknown as BatchTake[]) ?? [];
        if (takes.length) await this.batches.giveBack(tx, takes, line.qtyMilli);
      }
      await this.inventory.apply(
        tx, tenant.id,
        t.lines.map((l) => ({ storeId: t.fromStoreId, productId: l.productId, deltaMilli: l.qtyMilli, reason: 'TRANSFER_IN' as const, refType: 'StockTransfer', refId: t.id, note: `${t.number} cancelled`, userId: ctx.actorUserId })),
      );
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'transfer.cancelled', entityType: 'StockTransfer', entityId: id });
      return tx.stockTransfer.update({ where: { id }, data: { status: 'CANCELLED' } });
    });
  }

  // ── store prices ──
  storePrices(tenant: TenantContext, storeId: string) {
    return this.tenantDb.run(tenant.id, (tx) => tx.storePrice.findMany({ where: { storeId } }));
  }

  setStorePrices(tenant: TenantContext, ctx: Ctx, storeId: string, input: z.infer<typeof StorePricesSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      if (!(await tx.store.findUnique({ where: { id: storeId } }))) throw AppError.notFound('Store not found');
      for (const p of input.prices) {
        if (!(await tx.product.findUnique({ where: { id: p.productId } }))) throw AppError.notFound('Product not found');
        if (p.price === null) await tx.storePrice.deleteMany({ where: { storeId, productId: p.productId } });
        else
          await tx.storePrice.upsert({
            where: { storeId_productId: { storeId, productId: p.productId } },
            create: { tenantId: tenant.id, storeId, productId: p.productId, price: p.price },
            update: { price: p.price },
          });
      }
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'store_prices.set', entityType: 'Store', entityId: storeId, after: input });
      return tx.storePrice.findMany({ where: { storeId } });
    });
  }
}
