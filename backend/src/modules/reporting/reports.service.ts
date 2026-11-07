import { Injectable } from '@nestjs/common';
import type { TenantContext } from '../../common/request-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { SettingsService } from '../settings/settings.service.js';

export interface SalesSummary {
  currency: string;
  range: { from: string; to: string; timezone: string };
  sales: { count: number; subtotal: number; discountTotal: number; taxTotal: number; total: number };
  voids: { count: number; total: number };
  refunds: { count: number; total: number };
  net: number;
  payments: { method: string; amount: number }[];
  byDay: { day: string; count: number; total: number }[];
  topProducts: { productId: string; name: string; qtyMilli: number; total: number }[];
  taxes: { name: string; rateBp: number; taxable: number; amount: number }[];
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly settings: SettingsService,
  ) {}

  async summary(tenant: TenantContext, from: Date, to: Date, storeId?: string): Promise<SalesSummary> {
    const profile = await this.settings.profile(tenant.id);
    const tz = profile.timezone;
    const saleWhere: Prisma.SaleWhereInput = { soldAt: { gte: from, lt: to }, ...(storeId ? { storeId } : {}) };
    const done: Prisma.SaleWhereInput = { ...saleWhere, status: 'COMPLETED' };
    return this.tenantDb.run(tenant.id, async (tx) => {
      const storeSql = storeId ? Prisma.sql`AND "storeId" = ${storeId}::uuid` : Prisma.empty;
      const [completed, voided, refunds, payments, byDay, top, taxRows] = await Promise.all([
        tx.sale.aggregate({ where: done, _count: true, _sum: { subtotal: true, discountTotal: true, taxTotal: true, due: true } }),
        tx.sale.aggregate({ where: { ...saleWhere, status: 'VOIDED' }, _count: true, _sum: { due: true } }),
        tx.refund.aggregate({ where: { createdAt: { gte: from, lt: to }, ...(storeId ? { storeId } : {}) }, _count: true, _sum: { total: true, rounding: true } }),
        tx.payment.groupBy({ by: ['method'], where: { sale: done }, _sum: { amount: true } }),
        tx.$queryRaw<{ day: string; count: bigint; total: bigint }[]>`
          SELECT to_char(("soldAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day, count(*) AS count, sum("due") AS total
          FROM "Sale" WHERE status = 'COMPLETED' AND "soldAt" >= ${from} AND "soldAt" < ${to} ${storeSql}
          GROUP BY 1 ORDER BY 1`,
        tx.saleLine.groupBy({
          by: ['productId', 'name'],
          where: { sale: done },
          _sum: { qtyMilli: true, total: true },
          orderBy: { _sum: { total: 'desc' } },
          take: 10,
        }),
        tx.sale.findMany({ where: done, select: { taxes: true } }),
      ]);
      const taxes = new Map<string, { name: string; rateBp: number; taxable: number; amount: number }>();
      for (const row of taxRows) {
        for (const t of (row.taxes as { id: string; name: string; rateBp: number; taxable: number; amount: number }[]) ?? []) {
          const k = `${t.name}|${t.rateBp}`;
          const acc = taxes.get(k) ?? { name: t.name, rateBp: t.rateBp, taxable: 0, amount: 0 };
          acc.taxable += t.taxable;
          acc.amount += t.amount;
          taxes.set(k, acc);
        }
      }
      const salesTotal = completed._sum.due ?? 0;
      const refundTotal = (refunds._sum.total ?? 0) + (refunds._sum.rounding ?? 0);
      return {
        currency: profile.currency,
        range: { from: from.toISOString(), to: to.toISOString(), timezone: tz },
        sales: {
          count: completed._count,
          subtotal: completed._sum.subtotal ?? 0,
          discountTotal: completed._sum.discountTotal ?? 0,
          taxTotal: completed._sum.taxTotal ?? 0,
          total: salesTotal,
        },
        voids: { count: voided._count, total: voided._sum.due ?? 0 },
        refunds: { count: refunds._count, total: refundTotal },
        net: salesTotal - refundTotal,
        payments: payments.map((p) => ({ method: p.method, amount: p._sum.amount ?? 0 })),
        byDay: byDay.map((d) => ({ day: d.day, count: Number(d.count), total: Number(d.total) })),
        topProducts: top.map((t) => ({ productId: t.productId, name: t.name, qtyMilli: t._sum.qtyMilli ?? 0, total: t._sum.total ?? 0 })),
        taxes: [...taxes.values()],
      };
    });
  }
}
