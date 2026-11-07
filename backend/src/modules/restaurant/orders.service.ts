import { Injectable } from '@nestjs/common';
import { type AddOrderLinesSchema, chooseModifiers, type DiningTableSchema, type OpenOrderSchema, type PayOrderSchema, withModifiers } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext, TenantContext } from '../../common/request-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { SalesService } from '../sales/sales.service.js';
import { ModifiersService } from './modifiers.service.js';

const orderInclude = {
  lines: { orderBy: [{ course: 'asc' }, { createdAt: 'asc' }] },
  table: { select: { id: true, name: true, area: true } },
} as const satisfies Prisma.OrderInclude;

/** Kitchen tickets older than this drop off the display. */
const KITCHEN_WINDOW_MS = 6 * 3_600_000;

@Injectable()
export class OrdersService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly modifiers: ModifiersService,
    private readonly sales: SalesService,
    private readonly audit: AuditService,
  ) {}

  private async storeOf(tx: Tx, registerId: string) {
    return (await tx.register.findUniqueOrThrow({ where: { id: registerId }, select: { storeId: true } })).storeId;
  }

  private async orderInStore(tx: Tx, id: string, storeId: string) {
    const o = await tx.order.findUnique({ where: { id }, include: orderInclude });
    if (!o || o.storeId !== storeId) throw AppError.notFound('Order not found');
    return o;
  }

  // ── tables (back office) ──
  listTables(tenant: TenantContext, storeId?: string) {
    return this.tenantDb.run(tenant.id, (tx) => tx.diningTable.findMany({ where: storeId ? { storeId } : {}, orderBy: [{ area: 'asc' }, { name: 'asc' }] }));
  }

  createTable(tenant: TenantContext, ctx: ReturnType<typeof auditContext>, input: z.infer<typeof DiningTableSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      if (!(await tx.store.findUnique({ where: { id: input.storeId } }))) throw AppError.notFound('Store not found');
      const t = await tx.diningTable.create({ data: { tenantId: tenant.id, ...input, area: input.area ?? null } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'table.created', entityType: 'DiningTable', entityId: t.id, after: input });
      return t;
    });
  }

  // ── floor (till) ──
  /** The device's store: every table with its open order summary, plus open tabs without a table. */
  floor(tenant: TenantContext, registerId: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const storeId = await this.storeOf(tx, registerId);
      const [tables, open] = await Promise.all([
        tx.diningTable.findMany({ where: { storeId, active: true }, orderBy: [{ area: 'asc' }, { name: 'asc' }] }),
        tx.order.findMany({ where: { storeId, status: 'OPEN' }, include: { lines: { where: { status: { not: 'VOID' } } } }, orderBy: { createdAt: 'asc' } }),
      ]);
      const summary = (o: (typeof open)[number]) => ({
        id: o.id, name: o.name, guests: o.guests, createdAt: o.createdAt,
        total: o.lines.reduce((s, l) => s + Math.round((l.unitPrice * (l.qtyMilli - l.paidQtyMilli)) / 1000), 0),
        unsent: o.lines.filter((l) => l.status === 'NEW').length,
        ready: o.lines.filter((l) => l.status === 'READY').length,
      });
      return {
        tables: tables.map((t) => {
          const o = open.find((x) => x.tableId === t.id);
          return { id: t.id, name: t.name, area: t.area, seats: t.seats, order: o ? summary(o) : null };
        }),
        tabs: open.filter((o) => !o.tableId).map(summary),
      };
    });
  }

  open(req: RequestWithContext, input: z.infer<typeof OpenOrderSchema>) {
    const tenant = req.tenant!;
    return this.tenantDb.run(tenant.id, async (tx) => {
      const existing = await tx.order.findUnique({ where: { id: input.id }, include: orderInclude });
      if (existing) return existing;
      const storeId = await this.storeOf(tx, req.device!.registerId);
      if (input.tableId) {
        const table = await tx.diningTable.findUnique({ where: { id: input.tableId } });
        if (!table || table.storeId !== storeId) throw AppError.notFound('Table not found');
        if (await tx.order.count({ where: { tableId: input.tableId, status: 'OPEN' } })) throw AppError.conflict('This table already has an open order');
      } else if (!input.name) throw AppError.validation([{ path: 'name', message: 'A tab without a table needs a name' }]);
      const o = await tx.order.create({
        data: { id: input.id, tenantId: tenant.id, storeId, tableId: input.tableId ?? null, name: input.name ?? null, guests: input.guests ?? null, openedById: req.principal!.userId },
        include: orderInclude,
      });
      await this.audit.record(tx, tenant.id, { ...auditContext(req), action: 'order.opened', entityType: 'Order', entityId: o.id, after: input });
      return o;
    });
  }

  get(req: RequestWithContext, id: string) {
    return this.tenantDb.run(req.tenant!.id, async (tx) => this.orderInStore(tx, id, await this.storeOf(tx, req.device!.registerId)));
  }

  addLines(req: RequestWithContext, id: string, input: z.infer<typeof AddOrderLinesSchema>) {
    const tenant = req.tenant!;
    return this.tenantDb.run(tenant.id, async (tx) => {
      const order = await this.orderInStore(tx, id, await this.storeOf(tx, req.device!.registerId));
      if (order.status !== 'OPEN') throw new AppError('INVALID_STATE', 409, 'This order is closed');
      const products = await tx.product.findMany({ where: { id: { in: input.lines.map((l) => l.productId) }, active: true, hasVariants: false } });
      const byId = new Map(products.map((p) => [p.id, p]));
      const groups = await this.modifiers.forProducts(tx, products.map((p) => p.id));
      for (const l of input.lines) {
        if (order.lines.some((x) => x.id === l.id)) continue; // retried
        const p = byId.get(l.productId);
        if (!p) throw AppError.notFound('Product not found or not sellable');
        const r = chooseModifiers(groups.get(p.id) ?? [], l.modifierIds);
        if (!r.ok) throw new AppError('INVALID_STATE', 409, `${p.name}: ${r.reason}`, { productId: p.id });
        const mods = r.chosen.map((c) => ({ id: c.id, name: c.name, priceDelta: c.priceDelta }));
        await tx.orderLine.create({
          data: {
            id: l.id, tenantId: tenant.id, orderId: id, productId: p.id, name: p.name, qtyMilli: l.qtyMilli, unitPrice: withModifiers(p.price, mods),
            modifiers: mods as unknown as Prisma.InputJsonValue, note: l.note ?? null, course: l.course, createdById: req.principal!.userId,
          },
        });
      }
      return this.orderInStore(tx, id, order.storeId);
    });
  }

  /** Unsent lines can be removed freely; once the kitchen has them, removing is a void and needs a manager. */
  removeLine(req: RequestWithContext, id: string, lineId: string, approvedById: string | null) {
    const tenant = req.tenant!;
    return this.tenantDb.run(tenant.id, async (tx) => {
      const order = await this.orderInStore(tx, id, await this.storeOf(tx, req.device!.registerId));
      const line = order.lines.find((l) => l.id === lineId);
      if (!line) throw AppError.notFound('Order line not found');
      if (line.paidQtyMilli > 0) throw new AppError('INVALID_STATE', 409, 'This line is (partly) paid');
      if (line.status === 'NEW') await tx.orderLine.delete({ where: { id: lineId } });
      else {
        if (!approvedById) throw new AppError('STEP_UP_REQUIRED', 403, 'Manager approval required', { action: 'sale.void' });
        await tx.orderLine.update({ where: { id: lineId }, data: { status: 'VOID' } });
        await this.audit.record(tx, tenant.id, {
          ...auditContext(req), action: 'order.line_voided', entityType: 'Order', entityId: id, after: { lineId, name: line.name, approvedById },
        });
      }
      return this.orderInStore(tx, id, order.storeId);
    });
  }

  send(req: RequestWithContext, id: string) {
    return this.tenantDb.run(req.tenant!.id, async (tx) => {
      const order = await this.orderInStore(tx, id, await this.storeOf(tx, req.device!.registerId));
      await tx.orderLine.updateMany({ where: { orderId: id, status: 'NEW' }, data: { status: 'SENT', sentAt: new Date() } });
      return this.orderInStore(tx, id, order.storeId);
    });
  }

  move(req: RequestWithContext, id: string, tableId: string) {
    return this.tenantDb.run(req.tenant!.id, async (tx) => {
      const order = await this.orderInStore(tx, id, await this.storeOf(tx, req.device!.registerId));
      const table = await tx.diningTable.findUnique({ where: { id: tableId } });
      if (!table || table.storeId !== order.storeId) throw AppError.notFound('Table not found');
      if (await tx.order.count({ where: { tableId, status: 'OPEN', id: { not: id } } })) throw AppError.conflict('That table already has an open order');
      await tx.order.update({ where: { id }, data: { tableId } });
      return this.orderInStore(tx, id, order.storeId);
    });
  }

  /** Pays for some or all of the order: a sale made from the chosen order lines. */
  async pay(req: RequestWithContext, id: string, input: z.infer<typeof PayOrderSchema>) {
    const order = await this.get(req, id);
    const existing = await this.tenantDb.run(req.tenant!.id, (tx) => this.sales.getSale(tx, input.saleId));
    if (existing) return existing;
    if (order.status !== 'OPEN') throw new AppError('INVALID_STATE', 409, 'This order is closed');
    const lines = input.lines.map((sel) => {
      const l = order.lines.find((x) => x.id === sel.orderLineId);
      if (!l || l.status === 'VOID') throw AppError.notFound('Order line not found');
      if (sel.qtyMilli > l.qtyMilli - l.paidQtyMilli) throw new AppError('INVALID_STATE', 409, `Only ${l.qtyMilli - l.paidQtyMilli} of ${l.name} is left to pay`);
      return {
        productId: l.productId, qtyMilli: sel.qtyMilli, modifierIds: (l.modifiers as { id: string }[]).map((m) => m.id), ...(l.note ? { note: l.note } : {}),
      };
    });
    return this.sales.create(
      req,
      {
        id: input.saleId, lines, payments: input.payments, tip: input.tip, expectedTotal: input.expectedTotal,
        ...(input.cartDiscount ? { cartDiscount: input.cartDiscount } : {}), ...(input.customerId ? { customerId: input.customerId } : {}),
      },
      { orderId: id, lines: input.lines },
    );
  }

  cancel(req: RequestWithContext, id: string, approvedById: string | null) {
    const tenant = req.tenant!;
    return this.tenantDb.run(tenant.id, async (tx) => {
      const order = await this.orderInStore(tx, id, await this.storeOf(tx, req.device!.registerId));
      if (order.lines.some((l) => l.paidQtyMilli > 0)) throw new AppError('INVALID_STATE', 409, 'Part of this order is paid; pay or void the rest instead');
      if (order.lines.some((l) => l.status !== 'NEW' && l.status !== 'VOID') && !approvedById) {
        throw new AppError('STEP_UP_REQUIRED', 403, 'Manager approval required', { action: 'sale.void' });
      }
      await tx.order.update({ where: { id }, data: { status: 'CANCELLED', closedAt: new Date() } });
      await this.audit.record(tx, tenant.id, { ...auditContext(req), action: 'order.cancelled', entityType: 'Order', entityId: id, after: { approvedById } });
      return { id, status: 'CANCELLED' };
    });
  }

  // ── kitchen ──
  /** Tickets for the store's kitchen: sent lines of open orders, oldest first. */
  kitchen(tenant: TenantContext, registerId: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const storeId = await this.storeOf(tx, registerId);
      const since = new Date(Date.now() - KITCHEN_WINDOW_MS);
      const orders = await tx.order.findMany({
        where: { storeId, status: { in: ['OPEN', 'CLOSED'] }, lines: { some: { status: { in: ['SENT', 'PREPARING', 'READY'] }, sentAt: { gte: since } } } },
        include: { table: { select: { name: true } }, lines: { where: { status: { in: ['SENT', 'PREPARING', 'READY'] } }, orderBy: [{ course: 'asc' }, { sentAt: 'asc' }] } },
        orderBy: { createdAt: 'asc' },
      });
      return orders.map((o) => ({
        orderId: o.id, table: o.table?.name ?? null, name: o.name, firstSentAt: o.lines.reduce<Date | null>((m, l) => (l.sentAt && (!m || l.sentAt < m) ? l.sentAt : m), null),
        lines: o.lines.map((l) => ({ id: l.id, name: l.name, qtyMilli: l.qtyMilli, modifiers: l.modifiers, note: l.note, course: l.course, status: l.status, sentAt: l.sentAt })),
      }));
    });
  }

  bump(tenant: TenantContext, registerId: string, lineId: string, status: 'PREPARING' | 'READY' | 'SERVED') {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const storeId = await this.storeOf(tx, registerId);
      const line = await tx.orderLine.findUnique({ where: { id: lineId }, include: { order: { select: { storeId: true } } } });
      if (!line || line.order.storeId !== storeId) throw AppError.notFound('Ticket not found');
      if (line.status === 'NEW' || line.status === 'VOID') throw new AppError('INVALID_STATE', 409, 'This line is not with the kitchen');
      return tx.orderLine.update({ where: { id: lineId }, data: { status, ...(status === 'READY' ? { readyAt: new Date() } : {}) } });
    });
  }
}
