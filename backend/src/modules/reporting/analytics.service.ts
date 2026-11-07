import { Injectable } from '@nestjs/common';
import { minorDigits, toCsv } from '@pos/shared';
import type { TenantContext } from '../../common/request-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { SettingsService } from '../settings/settings.service.js';

export type Breakdown = 'store' | 'category' | 'cashier' | 'hour' | 'product';

export interface BreakdownRow {
  key: string;
  label: string;
  sales: number;
  qtyMilli: number;
  revenue: number;
  cost: number;
  margin: number;
}

/**
 * Deeper reports over completed sales: revenue, cost and margin by store, category, cashier, hour of
 * day (tenant time zone) or product; stock valuation and low stock; CSV export of sale lines.
 * Revenue is line totals (tax included as sold); refunds are reported separately in the summary.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly settings: SettingsService,
  ) {}

  async breakdown(tenant: TenantContext, by: Breakdown, from: Date, to: Date, storeId?: string): Promise<BreakdownRow[]> {
    const tz = (await this.settings.profile(tenant.id)).timezone;
    const store = storeId ? Prisma.sql`AND s."storeId" = ${storeId}::uuid` : Prisma.empty;
    const key = {
      store: Prisma.sql`s."storeId"::text`,
      category: Prisma.sql`COALESCE(p."categoryId"::text, '')`,
      cashier: Prisma.sql`s."cashierId"::text`,
      hour: Prisma.sql`to_char((s."soldAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'HH24')`,
      product: Prisma.sql`l."productId"::text`,
    }[by];
    return this.tenantDb.run(tenant.id, async (tx) => {
      const rows = await tx.$queryRaw<{ key: string; sales: bigint; qty: bigint; revenue: bigint; cost: bigint }[]>`
        SELECT ${key} AS key, count(DISTINCT s.id) AS sales, sum(l."qtyMilli") AS qty, sum(l.total) AS revenue,
               sum(round(l."unitCost"::numeric * l."qtyMilli" / 1000)) AS cost
        FROM "SaleLine" l
        JOIN "Sale" s ON s.id = l."saleId"
        LEFT JOIN "Product" p ON p.id = l."productId"
        WHERE s.status = 'COMPLETED' AND s."soldAt" >= ${from} AND s."soldAt" < ${to} ${store}
        GROUP BY 1 ORDER BY revenue DESC NULLS LAST LIMIT 500`;
      const ids = rows.map((r) => r.key).filter((k) => /^[0-9a-f-]{36}$/.test(k));
      const labels = new Map<string, string>();
      if (by === 'store') for (const s of await tx.store.findMany({ where: { id: { in: ids } } })) labels.set(s.id, `${s.code} · ${s.name}`);
      if (by === 'category') for (const c of await tx.category.findMany({ where: { id: { in: ids } } })) labels.set(c.id, c.name);
      if (by === 'cashier') for (const u of await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) labels.set(u.id, u.name);
      if (by === 'product') for (const p of await tx.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) labels.set(p.id, p.name);
      const out = rows.map((r) => {
        const revenue = Number(r.revenue ?? 0);
        const cost = Number(r.cost ?? 0);
        return {
          key: r.key, label: labels.get(r.key) ?? (by === 'hour' ? `${r.key}:00` : r.key || 'Uncategorised'),
          sales: Number(r.sales), qtyMilli: Number(r.qty ?? 0), revenue, cost, margin: revenue - cost,
        };
      });
      return by === 'hour' ? out.sort((a, b) => a.key.localeCompare(b.key)) : out;
    });
  }

  /** What stock is worth at cost, per store, and what has fallen to its reorder point. */
  inventory(tenant: TenantContext, storeId: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const [products, levels] = await Promise.all([
        tx.product.findMany({ where: { trackStock: true, hasVariants: false }, select: { id: true, name: true, sku: true, costPrice: true, reorderPoint: true, active: true } }),
        tx.stockLevel.findMany({ where: { storeId } }),
      ]);
      const qty = new Map(levels.map((l) => [l.productId, l.qtyMilli]));
      const rows = products.map((p) => {
        const q = qty.get(p.id) ?? 0;
        return {
          productId: p.id, name: p.name, sku: p.sku, qtyMilli: q, unitCost: p.costPrice, value: Math.round((Math.max(0, q) * p.costPrice) / 1000),
          reorderPoint: p.reorderPoint, low: p.reorderPoint !== null && q <= p.reorderPoint, negative: q < 0,
        };
      });
      return { totalValue: rows.reduce((s, r) => s + r.value, 0), rows: rows.sort((a, b) => b.value - a.value), low: rows.filter((r) => r.low) };
    });
  }

  /** Sale lines as CSV for accountants and spreadsheets. */
  async salesCsv(tenant: TenantContext, from: Date, to: Date, storeId?: string): Promise<string> {
    const profile = await this.settings.profile(tenant.id);
    const tz = profile.timezone;
    const m = (n: number) => n / 10 ** minorDigits(profile.currency);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    return this.tenantDb.run(tenant.id, async (tx) => {
      const sales = await tx.sale.findMany({
        where: { soldAt: { gte: from, lt: to }, ...(storeId ? { storeId } : {}) },
        orderBy: { soldAt: 'asc' },
        take: 50_000,
        include: { lines: { orderBy: { position: 'asc' } }, payments: true },
      });
      const rows = sales.flatMap((s) =>
        s.lines.map((l) => ({
          receipt: s.receiptNo, soldAt: fmt.format(s.soldAt), status: s.status, product: l.name, sku: l.sku, qty: l.qtyMilli / 1000,
          unitPrice: m(l.unitPrice), discount: m(l.discount), tax: m(l.tax), total: m(l.total), unitCost: m(l.unitCost),
          payment: s.payments.map((p) => p.method).join('+'), offline: s.offline ? 'yes' : '',
        })),
      );
      return toCsv(rows, ['receipt', 'soldAt', 'status', 'product', 'sku', 'qty', 'unitPrice', 'discount', 'tax', 'total', 'unitCost', 'payment', 'offline']);
    });
  }
}
