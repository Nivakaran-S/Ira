import { Injectable } from '@nestjs/common';
import type { CategorySchema, CreateVariantsSchema, ProductSchema, TaxGroupSchema, TaxRateDef, TaxRateSchema, UpdateProductSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { PlanLimitsService } from '../access/plan-limits.service.js';

type Ctx = ReturnType<typeof auditContext>;

const groupInclude = { rates: { orderBy: { position: 'asc' }, include: { rate: true } } } as const satisfies Prisma.TaxGroupInclude;
type GroupWithRates = Prisma.TaxGroupGetPayload<{ include: typeof groupInclude }>;

/** A tax group as the pricing engine wants it: ordered, active rates only. */
export function taxStack(group: GroupWithRates | null | undefined): TaxRateDef[] {
  if (!group) return [];
  return group.rates
    .filter((r) => r.rate.active)
    .map((r) => ({ id: r.rate.id, name: r.rate.name, rateBp: r.rate.rateBp, compound: r.rate.compound }));
}

/** The prices a register's store has set for itself (multi-store), by product. */
export async function storePrices(tx: Tx, registerId: string): Promise<Map<string, number>> {
  const reg = await tx.register.findUnique({ where: { id: registerId }, select: { storeId: true } });
  if (!reg) return new Map();
  return new Map((await tx.storePrice.findMany({ where: { storeId: reg.storeId } })).map((sp) => [sp.productId, sp.price]));
}

export const productInclude = { taxGroup: { include: groupInclude } } as const satisfies Prisma.ProductInclude;
export type ProductWithTax = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

@Injectable()
export class CatalogService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly limits: PlanLimitsService,
  ) {}

  // ── tax rates ──
  listTaxRates(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) => tx.taxRate.findMany({ orderBy: { name: 'asc' } }));
  }

  createTaxRate(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof TaxRateSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const rate = await tx.taxRate.create({ data: { tenantId: tenant.id, ...input } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'tax_rate.created', entityType: 'TaxRate', entityId: rate.id, after: input });
      return rate;
    });
  }

  /** Rates are referenced by past sales by value, so editing one never rewrites history. */
  updateTaxRate(tenant: TenantContext, ctx: Ctx, id: string, input: Partial<z.infer<typeof TaxRateSchema>>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const before = await tx.taxRate.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Tax rate not found');
      const rate = await tx.taxRate.update({ where: { id }, data: input });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'tax_rate.updated', entityType: 'TaxRate', entityId: id, before, after: input });
      return rate;
    });
  }

  // ── tax groups ──
  listTaxGroups(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const groups = await tx.taxGroup.findMany({ orderBy: { name: 'asc' }, include: groupInclude });
      return groups.map((g) => ({ id: g.id, name: g.name, rateIds: g.rates.map((r) => r.rateId), rates: taxStack(g) }));
    });
  }

  private async writeGroupRates(tx: Tx, tenantId: string, groupId: string, rateIds: string[]) {
    if (new Set(rateIds).size !== rateIds.length) throw AppError.validation([{ path: 'rateIds', message: 'Duplicate rate' }]);
    const found = await tx.taxRate.count({ where: { id: { in: rateIds } } });
    if (found !== rateIds.length) throw AppError.notFound('Tax rate not found');
    await tx.taxGroupRate.deleteMany({ where: { groupId } });
    if (rateIds.length) {
      await tx.taxGroupRate.createMany({ data: rateIds.map((rateId, position) => ({ tenantId, groupId, rateId, position })) });
    }
  }

  createTaxGroup(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof TaxGroupSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const group = await tx.taxGroup.create({ data: { tenantId: tenant.id, name: input.name } });
      await this.writeGroupRates(tx, tenant.id, group.id, input.rateIds);
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'tax_group.created', entityType: 'TaxGroup', entityId: group.id, after: input });
      return { id: group.id, name: group.name, rateIds: input.rateIds };
    });
  }

  updateTaxGroup(tenant: TenantContext, ctx: Ctx, id: string, input: z.infer<typeof TaxGroupSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const before = await tx.taxGroup.findUnique({ where: { id }, include: groupInclude });
      if (!before) throw AppError.notFound('Tax group not found');
      await tx.taxGroup.update({ where: { id }, data: { name: input.name } });
      await this.writeGroupRates(tx, tenant.id, id, input.rateIds);
      await this.audit.record(tx, tenant.id, {
        ...ctx, action: 'tax_group.updated', entityType: 'TaxGroup', entityId: id,
        before: { name: before.name, rateIds: before.rates.map((r) => r.rateId) }, after: input,
      });
      return { id, name: input.name, rateIds: input.rateIds };
    });
  }

  // ── categories ──
  listCategories(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) => tx.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }));
  }

  createCategory(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof CategorySchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const c = await tx.category.create({ data: { tenantId: tenant.id, ...input } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'category.created', entityType: 'Category', entityId: c.id, after: input });
      return c;
    });
  }

  updateCategory(tenant: TenantContext, ctx: Ctx, id: string, input: Partial<z.infer<typeof CategorySchema>>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const before = await tx.category.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Category not found');
      const c = await tx.category.update({ where: { id }, data: input });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'category.updated', entityType: 'Category', entityId: id, before, after: input });
      return c;
    });
  }

  // ── products ──
  listProducts(tenant: TenantContext, q: { search?: string; categoryId?: string; includeInactive?: boolean }) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.product.findMany({
        where: {
          ...(q.includeInactive ? {} : { active: true }),
          ...(q.categoryId ? { categoryId: q.categoryId } : {}),
          ...(q.search
            ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { sku: { equals: q.search, mode: 'insensitive' } }] }
            : {}),
        },
        orderBy: { name: 'asc' },
        take: 500,
        include: { barcodes: { select: { code: true } }, modifierGroups: { select: { groupId: true }, orderBy: { position: 'asc' } } },
      }),
    );
  }

  // ── variants ──
  /**
   * Turns a product into a family and adds variants. Each variant is a product of its own (price,
   * SKU, stock, barcode), so selling, stock and sync need nothing special; the family is not sold.
   */
  createVariants(tenant: TenantContext, ctx: Ctx, parentId: string, input: z.infer<typeof CreateVariantsSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const parent = await tx.product.findUnique({ where: { id: parentId } });
      if (!parent) throw AppError.notFound('Product not found');
      if (parent.parentId) throw new AppError('INVALID_STATE', 409, 'A variant cannot have variants of its own');
      if (!parent.hasVariants) await tx.product.update({ where: { id: parentId }, data: { hasVariants: true } });
      const created = [];
      for (const v of input.variants) {
        await this.limits.assertCanAdd(tx, tenant, 'products');
        const p = await tx.product.create({
          data: {
            tenantId: tenant.id, parentId, variantLabel: v.variantLabel, name: `${parent.name} - ${v.variantLabel}`, sku: v.sku ?? null,
            price: v.price ?? parent.price, categoryId: parent.categoryId, taxGroupId: parent.taxGroupId, trackStock: parent.trackStock, active: parent.active,
          },
        });
        if (v.barcode) await tx.barcode.create({ data: { tenantId: tenant.id, code: v.barcode, productId: p.id } });
        created.push(p);
      }
      await this.audit.record(tx, tenant.id, {
        ...ctx, action: 'product.variants_created', entityType: 'Product', entityId: parentId, after: { variants: input.variants.map((v) => v.variantLabel) },
      });
      return created;
    });
  }

  variantsOf(tenant: TenantContext, parentId: string) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.product.findMany({ where: { parentId }, orderBy: { variantLabel: 'asc' }, include: { barcodes: { select: { code: true } } } }),
    );
  }

  // ── barcodes ──
  setBarcodes(tenant: TenantContext, ctx: Ctx, productId: string, codes: string[]) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product) throw AppError.notFound('Product not found');
      if (product.hasVariants) throw new AppError('INVALID_STATE', 409, 'Barcodes belong on the variants, not the family');
      const unique = [...new Set(codes)];
      const taken = await tx.barcode.findMany({ where: { code: { in: unique }, productId: { not: productId } }, select: { code: true } });
      if (taken.length) throw AppError.conflict('Barcode already used by another product', { codes: taken.map((t) => t.code) });
      await tx.barcode.deleteMany({ where: { productId, code: { notIn: unique } } });
      const existing = new Set((await tx.barcode.findMany({ where: { productId }, select: { code: true } })).map((b) => b.code));
      const added = unique.filter((c) => !existing.has(c));
      if (added.length) await tx.barcode.createMany({ data: added.map((code) => ({ tenantId: tenant.id, code, productId })) });
      // Removing a barcode must reach tills too: touching the product bumps its sync version.
      await tx.product.update({ where: { id: productId }, data: { updatedAt: new Date() } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'product.barcodes_set', entityType: 'Product', entityId: productId, after: { codes: unique } });
      return unique;
    });
  }

  findByBarcode(tenant: TenantContext, code: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const b = await tx.barcode.findUnique({ where: { tenantId_code: { tenantId: tenant.id, code } }, include: { product: { include: productInclude } } });
      if (!b || !b.product.active) throw AppError.notFound('No product with that barcode');
      const p = b.product;
      return { id: p.id, name: p.name, sku: p.sku, price: p.price, categoryId: p.categoryId, trackStock: p.trackStock, taxes: taxStack(p.taxGroup) };
    });
  }

  private async assertRefs(tx: Tx, input: { categoryId?: string | null; taxGroupId?: string | null }) {
    if (input.categoryId && !(await tx.category.findUnique({ where: { id: input.categoryId } }))) throw AppError.notFound('Category not found');
    if (input.taxGroupId && !(await tx.taxGroup.findUnique({ where: { id: input.taxGroupId } }))) throw AppError.notFound('Tax group not found');
  }

  createProduct(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof ProductSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      await this.assertRefs(tx, input);
      await this.limits.assertCanAdd(tx, tenant, 'products');
      const p = await tx.product.create({ data: { tenantId: tenant.id, ...input } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'product.created', entityType: 'Product', entityId: p.id, after: input });
      return p;
    });
  }

  updateProduct(tenant: TenantContext, ctx: Ctx, id: string, input: z.infer<typeof UpdateProductSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const before = await tx.product.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Product not found');
      await this.assertRefs(tx, input);
      const p = await tx.product.update({ where: { id }, data: input });
      await this.audit.record(tx, tenant.id, {
        ...ctx, action: 'product.updated', entityType: 'Product', entityId: id,
        before: { name: before.name, price: before.price, active: before.active, taxGroupId: before.taxGroupId }, after: input,
      });
      return p;
    });
  }

  /** Everything a till needs to ring up sales: active products with their resolved tax stack. */
  posCatalog(tenant: TenantContext, registerId?: string) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const prices = registerId ? await storePrices(tx, registerId) : new Map<string, number>();
      const [categories, products] = await Promise.all([
        tx.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true, color: true } }),
        tx.product.findMany({ where: { active: true }, orderBy: { name: 'asc' }, include: { ...productInclude, barcodes: { select: { code: true } } } }),
      ]);
      return {
        categories,
        products: products.map((p) => ({
          id: p.id, name: p.name, sku: p.sku, price: prices.get(p.id) ?? p.price, categoryId: p.categoryId, trackStock: p.trackStock, taxes: taxStack(p.taxGroup),
          hasVariants: p.hasVariants, parentId: p.parentId, variantLabel: p.variantLabel, barcodes: p.barcodes.map((b) => b.code),
          soldByWeight: p.soldByWeight, plu: p.plu, tracksBatches: p.tracksBatches, rxRequired: p.rxRequired,
        })),
      };
    });
  }
}
