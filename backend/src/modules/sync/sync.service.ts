import { Injectable } from '@nestjs/common';
import {
  applyPromotions, canonicalJson, cashRound, chooseModifiers, withModifiers, GENESIS, type OfflineOp, opHash, parseSettings, type Permission, priceWithPromotions, type SyncResult,
  type TaxRateDef, type TenantSettings,
} from '@pos/shared';
import { PrismaService } from '../../infra/prisma.service.js';
import { toDef } from '../promotions/promotions.service.js';
import { toGroupDef } from '../restaurant/modifiers.service.js';
import { ModifiersService } from '../restaurant/modifiers.service.js';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { type DevicePublicJwk, verifyDeviceSignature } from '../../security/device-signature.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { taxStack } from '../catalog/catalog.service.js';
import { type Approval, approvalNeeds, appliedPromotions, SalesService, settlePayments } from '../sales/sales.service.js';
import { ShiftsService } from '../sales/shifts.service.js';
import { SettingsService } from '../settings/settings.service.js';

const BLOCK_SIZE = 200;
const BLOCK_REFILL_BELOW = 50;
const FUTURE_SKEW_MS = 5 * 60_000;

type Ctx = ReturnType<typeof auditContext>;

/** A verification failure: the op goes to quarantine with this reason. */
class Reject extends Error {
  constructor(
    readonly reason: string,
    readonly details?: unknown,
  ) {
    super(reason);
  }
}

/** Checks a manager may waive when accepting a quarantined op. Chain, signature and arithmetic are never waived. */
export interface Waivers {
  window?: boolean;
  approvals?: boolean;
  prices?: boolean;
  method?: boolean;
}

const sameTaxes = (a: TaxRateDef[], b: TaxRateDef[]) =>
  a.length === b.length && a.every((t, i) => t.id === b[i].id && t.rateBp === b[i].rateBp && t.compound === b[i].compound);

@Injectable()
export class SyncService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly settings: SettingsService,
    private readonly capabilities: CapabilitiesService,
    private readonly sales: SalesService,
    private readonly shifts: ShiftsService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    private readonly modifierService: ModifiersService,
  ) {}

  private async businessTypeOf(tenantId: string) {
    return (await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessTypeId: true } })).businessTypeId;
  }

  // ───────────────────────────── down ─────────────────────────────

  async down(tenant: TenantContext, device: { id: string; registerId: string }, cursor: bigint, blockNext?: number) {
    const [profile, modules] = await Promise.all([this.settings.profile(tenant.id), this.capabilities.modulesFor(tenant)]);
    const data = await this.tenantDb.run(tenant.id, async (tx) => {
      const [barcodes, promotions, modifierGroups] = await Promise.all([
        modules.includes('barcodes') ? tx.barcode.findMany({ where: { version: { gt: cursor } }, select: { code: true, productId: true, version: true } }) : [],
        modules.includes('promotions') ? tx.promotion.findMany({ where: { version: { gt: cursor } } }) : [],
        modules.includes('modifiers')
          ? tx.modifierGroup.findMany({ where: { version: { gt: cursor } }, include: { options: { orderBy: { position: 'asc' } } } })
          : [],
      ]);
      const [register, dev, categories, products, groups, shift] = await Promise.all([
        tx.register.findUniqueOrThrow({ where: { id: device.registerId }, include: { store: { select: { id: true, name: true, code: true } } } }),
        tx.device.findUniqueOrThrow({ where: { id: device.id } }),
        tx.category.findMany({ where: { version: { gt: cursor } }, orderBy: { version: 'asc' } }),
        tx.product.findMany({ where: { version: { gt: cursor } }, orderBy: { version: 'asc' } }),
        tx.taxGroup.findMany({ where: { version: { gt: cursor } }, include: { rates: { orderBy: { position: 'asc' }, include: { rate: true } } } }),
        this.shifts.openShift(tx, device.registerId),
      ]);
      const block = await this.ensureBlock(tx, dev, register.id, blockNext);
      await tx.syncCursor.upsert({
        where: { deviceId: device.id },
        create: { deviceId: device.id, tenantId: tenant.id, lastHash: GENESIS, lastContactAt: new Date() },
        update: { lastContactAt: new Date() },
      });
      const users = await tx.user.findMany({ where: { status: 'ACTIVE', pinHash: { not: null } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
      const versions = [
        cursor, ...categories.map((c) => c.version), ...products.map((p) => p.version), ...groups.map((g) => g.version),
        ...barcodes.map((b) => b.version), ...promotions.map((p) => p.version), ...modifierGroups.map((g) => g.version),
      ];
      const links = products.length
        ? await tx.productModifierGroup.findMany({ where: { productId: { in: products.map((p) => p.id) } }, orderBy: { position: 'asc' } })
        : [];
      // A product touched since the cursor carries its full barcode list, so removed codes disappear too.
      const productBarcodes = products.length
        ? await tx.barcode.findMany({ where: { productId: { in: products.map((p) => p.id) } }, select: { code: true, productId: true } })
        : [];
      return {
        register, block, categories, products, groups, users, barcodes: [...barcodes, ...productBarcodes], promotions, modifierGroups, links,
        shift: shift ? await this.shifts.report(tx, shift.id) : null,
        next: versions.reduce((m, v) => (v > m ? v : m), cursor),
      };
    });
    const users = await Promise.all(
      data.users.map(async (u) => ({ ...u, permissions: [...(await this.capabilities.permissionsFor(tenant.id, u.id))].sort() })),
    );
    return {
      cursor: data.next.toString(),
      full: cursor === 0n,
      serverTime: new Date().toISOString(),
      currency: profile.currency,
      timezone: profile.timezone,
      tenantName: profile.name,
      settings: profile.settings,
      register: { id: data.register.id, code: data.register.code, name: data.register.name, store: data.register.store },
      receiptBlock: data.block,
      shift: data.shift,
      users,
      categories: data.categories.map((c) => ({ id: c.id, name: c.name, color: c.color, sortOrder: c.sortOrder })),
      modules,
      products: data.products.map((p) => ({
        id: p.id, name: p.name, sku: p.sku, price: p.price, categoryId: p.categoryId, taxGroupId: p.taxGroupId, active: p.active, trackStock: p.trackStock,
        hasVariants: p.hasVariants, parentId: p.parentId, variantLabel: p.variantLabel,
        modifierGroupIds: data.links.filter((l) => l.productId === p.id).map((l) => l.groupId),
      })),
      modifierGroups: data.modifierGroups.map(toGroupDef),
      /** code → productId; a product listed in `products` sends all its codes (replace, not merge). */
      barcodes: data.barcodes.map((b) => ({ code: b.code, productId: b.productId })),
      promotions: data.promotions.map(toDef),
      taxGroups: data.groups.map((g) => ({ id: g.id, name: g.name, rates: taxStack(g) })),
    };
  }

  /** Offline receipt numbers come from blocks reserved per device, so two tills can never collide. */
  private async ensureBlock(tx: Tx, dev: { id: string; offlineBlockStart: number | null; offlineBlockEnd: number | null }, registerId: string, blockNext?: number) {
    const start = dev.offlineBlockStart;
    const end = dev.offlineBlockEnd;
    const next = blockNext ?? start ?? 0;
    if (start !== null && end !== null && end - next + 1 >= BLOCK_REFILL_BELOW) return { start, end };
    const r = await tx.register.update({ where: { id: registerId }, data: { offlineSeq: { increment: BLOCK_SIZE } }, select: { offlineSeq: true } });
    const block = { start: r.offlineSeq - BLOCK_SIZE + 1, end: r.offlineSeq };
    await tx.device.update({ where: { id: dev.id }, data: { offlineBlockStart: block.start, offlineBlockEnd: block.end } });
    return block;
  }

  // ───────────────────────────── up ─────────────────────────────

  async up(tenant: TenantContext, device: { id: string; registerId: string }, ops: OfflineOp[], ctx: Ctx, rawOps: unknown[] = ops): Promise<{ results: SyncResult[] }> {
    const settings = await this.settings.get(tenant.id);
    const dev = await this.tenantDb.run(tenant.id, (tx) => tx.device.findUniqueOrThrow({ where: { id: device.id } }));
    const start = await this.tenantDb.run(tenant.id, (tx) =>
      tx.syncCursor.upsert({
        where: { deviceId: device.id },
        create: { deviceId: device.id, tenantId: tenant.id, lastHash: GENESIS, lastContactAt: new Date() },
        update: {},
      }),
    );
    const windowStart = start.lastContactAt;
    const results: SyncResult[] = [];
    // Hashes and signatures are checked against each op exactly as sent; validation may add defaults.
    const pairs = ops.map((op, i) => ({ op, raw: rawOps[i] as OfflineOp })).sort((a, b) => a.op.seq - b.op.seq);
    for (const { op, raw } of pairs) {
      results.push(await this.one(tenant, device, dev.publicKeyJwk as unknown as DevicePublicJwk, op, settings, windowStart, ctx, raw));
    }
    await this.tenantDb.run(tenant.id, (tx) => tx.syncCursor.update({ where: { deviceId: device.id }, data: { lastContactAt: new Date() } }));
    return { results };
  }

  private async one(
    tenant: TenantContext,
    device: { id: string; registerId: string },
    jwk: DevicePublicJwk,
    op: OfflineOp,
    settings: TenantSettings,
    windowStart: Date,
    ctx: Ctx,
    raw: OfflineOp = op,
  ): Promise<SyncResult> {
    const base = { id: op.payload.id, seq: op.seq };
    const authentic = !!raw?.payload && (await opHash(raw)) === op.hash && (await verifyDeviceSignature(jwk, op.hash, op.sig));

    return this.tenantDb.run(tenant.id, async (tx) => {
      const cursor = await tx.syncCursor.findUniqueOrThrow({ where: { deviceId: device.id } });
      if (await this.alreadyHave(tx, device.id, op)) return { ...base, status: 'duplicate' as const };
      if (!authentic) {
        // Not provably from this device: quarantined, and the chain does not move.
        return this.quarantine(tx, tenant.id, device, op, 'BAD_SIGNATURE', undefined, ctx);
      }
      const advance = () => tx.syncCursor.update({ where: { deviceId: device.id }, data: { lastSeq: Math.max(cursor.lastSeq, op.seq), lastHash: op.hash } });
      if (op.seq !== cursor.lastSeq + 1 || op.prevHash !== cursor.lastHash) {
        await advance();
        return this.quarantine(tx, tenant.id, device, op, 'CHAIN_GAP', { expectedSeq: cursor.lastSeq + 1, gotSeq: op.seq }, ctx);
      }
      try {
        await tx.$executeRaw`SAVEPOINT apply_op`;
        await this.apply(tx, tenant.id, device, op, settings, windowStart, {}, ctx);
        await tx.$executeRaw`RELEASE SAVEPOINT apply_op`;
        await advance();
        return { ...base, status: 'applied' as const };
      } catch (e) {
        const reject = this.asReject(e);
        if (!reject) throw e;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT apply_op`;
        await advance();
        return this.quarantine(tx, tenant.id, device, op, reject.reason, reject.details, ctx);
      }
    });
  }

  private asReject(e: unknown): Reject | null {
    if (e instanceof Reject) return e;
    if (e instanceof AppError) return new Reject(e.code, { message: e.message, ...(e.details ? { details: e.details } : {}) });
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return new Reject('DUPLICATE', { target: e.meta?.target });
    return null;
  }

  private async alreadyHave(tx: Tx, deviceId: string, op: OfflineOp) {
    const id = op.payload.id;
    const [found, quarantined] = await Promise.all([
      op.kind === 'sale'
        ? tx.sale.count({ where: { id } })
        : op.kind === 'refund'
          ? tx.refund.count({ where: { id } })
          : tx.cashMovement.count({ where: { id } }),
      tx.syncQuarantine.count({ where: { deviceId, opId: id } }),
    ]);
    return found + quarantined > 0;
  }

  private async quarantine(
    tx: Tx,
    tenantId: string,
    device: { id: string; registerId: string },
    op: OfflineOp,
    reason: string,
    details: unknown,
    ctx: Ctx,
  ): Promise<SyncResult> {
    const q = await tx.syncQuarantine.create({
      data: {
        tenantId, deviceId: device.id, registerId: device.registerId, opId: op.payload.id, kind: op.kind, seq: op.seq, reason,
        details: details === undefined ? Prisma.DbNull : (JSON.parse(JSON.stringify(details)) as Prisma.InputJsonValue),
        op: JSON.parse(JSON.stringify(op)) as Prisma.InputJsonValue,
      },
    });
    await this.audit.record(tx, tenantId, { ...ctx, action: 'sync.quarantined', entityType: 'SyncQuarantine', entityId: q.id, after: { kind: op.kind, opId: op.payload.id, reason } });
    return { id: op.payload.id, seq: op.seq, status: 'quarantined', reason };
  }

  /** Has the approvals the op needed, each from someone who holds the permission. */
  private async checkApprovals(tenantId: string, needs: { action: Permission }[], given: Approval[]) {
    for (const n of needs) {
      const a = given.find((g) => g.action === n.action);
      if (!a) throw new Reject('APPROVAL_MISSING', { action: n.action });
      if (!(await this.capabilities.permissionsFor(tenantId, a.approverId)).has(n.action)) throw new Reject('APPROVER_NOT_ALLOWED', { action: n.action, approverId: a.approverId });
    }
  }

  private async shiftFor(tx: Tx, device: { registerId: string }, shiftId: string) {
    const shift = await tx.shift.findUnique({ where: { id: shiftId } });
    if (!shift || shift.registerId !== device.registerId) throw new Reject('UNKNOWN_SHIFT', { shiftId });
    return shift;
  }

  private async apply(
    tx: Tx,
    tenantId: string,
    device: { id: string; registerId: string },
    op: OfflineOp,
    settings: TenantSettings,
    windowStart: Date,
    waive: Waivers,
    ctx: Ctx,
  ) {
    const at = new Date(op.createdAt);
    if (!waive.window) {
      if (at.getTime() > Date.now() + FUTURE_SKEW_MS) throw new Reject('FUTURE_TIMESTAMP', { createdAt: op.createdAt });
      const hours = (at.getTime() - windowStart.getTime()) / 3_600_000;
      if (hours > settings.offline.maxHours) throw new Reject('OUTSIDE_OFFLINE_WINDOW', { createdAt: op.createdAt, lastContactAt: windowStart.toISOString(), maxHours: settings.offline.maxHours });
    }
    const auditCtx = { ...ctx, actorUserId: null };

    if (op.kind === 'sale') {
      const s = op.payload;
      const shift = await this.shiftFor(tx, device, s.shiftId);
      if (!(await tx.user.count({ where: { id: s.cashierId } }))) throw new Reject('UNKNOWN_USER', { userId: s.cashierId });
      const cv = BigInt(s.catalogVersion);
      const products = await tx.product.findMany({ where: { id: { in: [...new Set(s.lines.map((l) => l.productId))] } }, include: { taxGroup: { include: { rates: { orderBy: { position: 'asc' }, include: { rate: true } } } } } });
      const byId = new Map(products.map((p) => [p.id, p]));
      const modGroups = await this.modifierService.forProducts(tx, [...byId.keys()]);
      for (const l of s.lines) {
        const p = byId.get(l.productId);
        if (!p) throw new Reject('UNKNOWN_PRODUCT', { productId: l.productId });
        const groups = modGroups.get(p.id) ?? [];
        if (!waive.prices && groups.every((g) => g.version <= cv) && p.version <= cv) {
          const r = chooseModifiers(groups, (l.modifiers ?? []).map((m) => m.id));
          if (!r.ok) throw new Reject('MODIFIER_MISMATCH', { productId: p.id, reason: r.reason });
          if (withModifiers(p.price, r.chosen) !== l.listPrice) throw new Reject('PRICE_MISMATCH', { productId: p.id, till: l.listPrice, server: withModifiers(p.price, r.chosen) });
        }
        // What the till knew is checkable when nothing about the product changed after its snapshot.
        const known = p.version <= cv && (p.taxGroup?.version ?? 0n) <= cv;
        if (!waive.prices && known) {
          if (!(l.modifiers ?? []).length && l.listPrice !== p.price) throw new Reject('PRICE_MISMATCH', { productId: p.id, till: l.listPrice, server: p.price });
          if (!sameTaxes(l.taxes, taxStack(p.taxGroup))) throw new Reject('TAX_MISMATCH', { productId: p.id });
        }
      }
      if (!waive.method && !settings.offline.allowCard && s.payments.some((p) => p.method !== 'CASH')) throw new Reject('METHOD_NOT_ALLOWED_OFFLINE');
      // Promotions: what the till applied must match the promotions it knew. If any promotion changed
      // after the till's snapshot, the till's version is the fact (like prices).
      const pricingLines = s.lines.map((l, i) => {
        const p = byId.get(l.productId)!;
        return { key: String(i), productId: p.id, categoryId: p.categoryId, unitPrice: l.unitPrice, qtyMilli: l.qtyMilli, taxes: l.taxes, discount: l.discount };
      });
      const applied = {
        lines: Object.fromEntries(s.lines.flatMap((l, i) => (l.promo ? [[String(i), [l.promo]]] : []))),
        cart: s.cartPromo ? [s.cartPromo] : [],
      };
      const promoOn = (await this.capabilities.modulesFor({ id: tenantId, businessTypeId: await this.businessTypeOf(tenantId) })).includes('promotions');
      if (!waive.prices) {
        const all = promoOn ? await tx.promotion.findMany() : [];
        const changed = all.some((p) => p.version > cv);
        if (!changed) {
          const fresh = applyPromotions(pricingLines, all.filter((p) => p.active).map(toDef), at);
          if (canonicalJson(fresh) !== canonicalJson(applied)) throw new Reject('PROMO_MISMATCH', { till: applied, server: fresh });
        }
      }
      const { priced } = priceWithPromotions({
        pricesIncludeTax: settings.pricesIncludeTax, lines: pricingLines, cartDiscount: s.cartDiscount, promotions: [], now: at, applied,
      });
      const allCash = s.payments.every((p) => p.method === 'CASH');
      const due = allCash ? cashRound(priced.totals.total, settings.cashRoundingUnit) : priced.totals.total;
      if (due !== s.expectedTotal) throw new Reject('TOTAL_MISMATCH', { expected: s.expectedTotal, actual: due });
      const payments = settlePayments(s.payments, due + s.tip);
      if (!waive.approvals) {
        const perms = await this.capabilities.permissionsFor(tenantId, s.cashierId);
        await this.checkApprovals(tenantId, approvalNeeds(perms, settings, s.lines, s.cartDiscount, priced), s.approvals);
      }
      await this.sales.persistSale(tx, tenantId, {
        id: s.id, storeId: shift.storeId, registerId: device.registerId, shiftId: shift.id, deviceId: device.id, cashierId: s.cashierId,
        receiptNo: s.receiptNo, pricesIncludeTax: settings.pricesIncludeTax, priced, due, payments, cartDiscount: s.cartDiscount,
        approvals: s.approvals, soldAt: at, offline: true, catalogVersion: cv, tip: s.tip,
        promotions: appliedPromotions(priced, new Map([...Object.values(applied.lines).flat(), ...applied.cart].map((a) => [a.label, a.promotionId]))),
        lines: s.lines.map((l) => {
          const p = byId.get(l.productId)!;
          return {
            productId: p.id, name: p.name, sku: p.sku, unitPrice: l.unitPrice, listPrice: l.listPrice, qtyMilli: l.qtyMilli, note: l.note, trackStock: p.trackStock,
            modifiers: l.modifiers ?? [],
          };
        }),
      }, { ...auditCtx, actorUserId: s.cashierId });
      return;
    }

    if (op.kind === 'refund') {
      const r = op.payload;
      const shift = await this.shiftFor(tx, device, r.shiftId);
      const sale = await this.sales.getSale(tx, r.saleId);
      if (!sale) throw new Reject('UNKNOWN_SALE', { saleId: r.saleId });
      if (sale.status !== 'COMPLETED') throw new Reject('SALE_VOIDED');
      const lines = this.sales.refundLines(sale, r);
      const total = lines.reduce((s, l) => s + l.total, 0);
      if (!waive.window && total > settings.offline.maxRefund) throw new Reject('OVER_OFFLINE_REFUND_LIMIT', { total, limit: settings.offline.maxRefund });
      if (!waive.approvals) {
        const perms = await this.capabilities.permissionsFor(tenantId, r.userId);
        const needed = !perms.has('sale.refund') || total > settings.stepUp.refundAbove;
        await this.checkApprovals(tenantId, needed ? [{ action: 'sale.refund' }] : [], r.approvals);
      }
      await this.sales.persistRefund(tx, tenantId, {
        id: r.id, saleId: sale.id, storeId: shift.storeId, registerId: device.registerId, shiftId: shift.id, deviceId: device.id, userId: r.userId,
        approvedById: r.approvals.find((a) => a.action === 'sale.refund')?.approverId ?? null, receiptNo: r.receiptNo, method: r.method,
        reason: r.reason, restock: r.restock, lines, total, taxTotal: lines.reduce((s, l) => s + l.tax, 0),
        paidOut: r.method === 'CASH' ? cashRound(total, settings.cashRoundingUnit) : total, offline: true, checkDrawer: false,
      }, { ...auditCtx, actorUserId: r.userId });
      return;
    }

    const c = op.payload;
    const shift = await this.shiftFor(tx, device, c.shiftId);
    if (!waive.approvals) {
      const holds = (await this.capabilities.permissionsFor(tenantId, c.userId)).has('drawer.open');
      await this.checkApprovals(tenantId, !holds || c.type === 'NO_SALE' ? [{ action: 'drawer.open' }] : [], c.approvals);
    }
    await tx.cashMovement.create({
      data: {
        id: c.id, tenantId, shiftId: shift.id, type: c.type, amount: c.type === 'NO_SALE' ? 0 : c.amount, reason: c.reason, userId: c.userId,
        approvedById: c.approvals[0]?.approverId ?? null, createdAt: at,
      },
    });
    await this.audit.record(tx, tenantId, {
      ...auditCtx, actorUserId: c.userId, action: `cash.${c.type.toLowerCase()}`, entityType: 'Shift', entityId: shift.id,
      after: { amount: c.amount, reason: c.reason, offline: true },
    });
  }

  // ───────────────────────────── review ─────────────────────────────

  list(tenant: TenantContext, status?: 'PENDING' | 'ACCEPTED' | 'REJECTED') {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.syncQuarantine.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200 }),
    );
  }

  pendingCount(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) => tx.syncQuarantine.count({ where: { status: 'PENDING' } }));
  }

  /**
   * A manager accepts a quarantined op: it is applied with the waived checks skipped. Arithmetic
   * (totals, payments, refund quantities) is never waived; such ops can only be rejected.
   */
  async accept(tenant: TenantContext, id: string, reviewerId: string, note: string, ctx: Ctx) {
    const settings = parseSettings((await this.settings.get(tenant.id)) as unknown);
    return this.tenantDb.run(tenant.id, async (tx) => {
      const q = await tx.syncQuarantine.findUnique({ where: { id } });
      if (!q) throw AppError.notFound('Quarantined item not found');
      if (q.status !== 'PENDING') throw new AppError('INVALID_STATE', 409, 'Already reviewed');
      if (q.reason === 'BAD_SIGNATURE') throw new AppError('INVALID_STATE', 409, 'Items that are not provably from the device cannot be accepted');
      const op = q.op as unknown as OfflineOp;
      try {
        await tx.$executeRaw`SAVEPOINT accept_op`;
        await this.apply(tx, tenant.id, { id: q.deviceId, registerId: q.registerId }, op, settings, new Date(0), { window: true, approvals: true, prices: true, method: true }, ctx);
      } catch (e) {
        const reject = this.asReject(e);
        if (!reject) throw e;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT accept_op`;
        throw new AppError('INVALID_STATE', 409, 'This item still fails verification and can only be rejected', { reason: reject.reason, details: reject.details });
      }
      await tx.syncQuarantine.update({ where: { id }, data: { status: 'ACCEPTED', reviewedById: reviewerId, reviewedAt: new Date(), reviewNote: note } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'sync.quarantine_accepted', entityType: 'SyncQuarantine', entityId: id, after: { reason: q.reason, note } });
      return tx.syncQuarantine.findUniqueOrThrow({ where: { id } });
    });
  }

  reject(tenant: TenantContext, id: string, reviewerId: string, note: string, ctx: Ctx) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const q = await tx.syncQuarantine.findUnique({ where: { id } });
      if (!q) throw AppError.notFound('Quarantined item not found');
      if (q.status !== 'PENDING') throw new AppError('INVALID_STATE', 409, 'Already reviewed');
      const updated = await tx.syncQuarantine.update({ where: { id }, data: { status: 'REJECTED', reviewedById: reviewerId, reviewedAt: new Date(), reviewNote: note } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'sync.quarantine_rejected', entityType: 'SyncQuarantine', entityId: id, after: { reason: q.reason, note } });
      return updated;
    });
  }
}
