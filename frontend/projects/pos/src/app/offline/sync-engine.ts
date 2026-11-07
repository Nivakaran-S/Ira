import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { GENESIS, type ModifierGroupDef, type OfflineOp, type OfflineOpKind, offlineReceiptNo, opHash, type PromotionDef, type SyncResult, type TaxRateDef, type TenantSettings } from '@pos/shared';
import { firstValueFrom } from 'rxjs';
import { ApiError, ToastService } from 'ui';
import type { CatalogCategory, CatalogProduct, PosCatalog, ShiftReport } from '../api/pos-api';
import { bytesToBase64Url } from '../device/device-signer';
import { PosSession } from '../device/pos-session';
import { LocalDb } from './local-db';

export interface SnapUser {
  id: string;
  name: string;
  permissions: string[];
}
interface SnapProduct {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  categoryId: string | null;
  taxGroupId: string | null;
  active: boolean;
  trackStock: boolean;
  hasVariants?: boolean;
  parentId?: string | null;
  variantLabel?: string | null;
  modifierGroupIds?: string[];
  soldByWeight?: boolean;
  plu?: string | null;
  tracksBatches?: boolean;
  rxRequired?: boolean;
}
export interface Snapshot {
  cursor: string;
  currency: string;
  timezone: string;
  tenantName: string;
  settings: TenantSettings;
  register: { id: string; code: string; name: string; store: { id: string; name: string; code: string } };
  users: SnapUser[];
  categories: Record<string, CatalogCategory & { sortOrder: number }>;
  products: Record<string, SnapProduct>;
  taxGroups: Record<string, { id: string; name: string; rates: TaxRateDef[] }>;
  shift: ShiftReport | null;
  modules: string[];
  /** Barcode → product id. */
  barcodes: Record<string, string>;
  promotions: Record<string, PromotionDef>;
  modifierGroups: Record<string, ModifierGroupDef>;
}
interface SyncState {
  lastContactAt: number | null;
  block: { start: number; end: number; next: number } | null;
  chain: { seq: number; prevHash: string };
}
interface DownResponse {
  cursor: string;
  full: boolean;
  currency: string;
  timezone: string;
  tenantName: string;
  settings: TenantSettings;
  register: Snapshot['register'];
  receiptBlock: { start: number; end: number };
  shift: ShiftReport | null;
  users: SnapUser[];
  categories: (CatalogCategory & { sortOrder: number })[];
  products: SnapProduct[];
  taxGroups: { id: string; name: string; rates: TaxRateDef[] }[];
  modules: string[];
  barcodes: { code: string; productId: string }[];
  promotions: PromotionDef[];
  modifierGroups?: ModifierGroupDef[];
}

const SYNC_EVERY_MS = 15_000;
const BATCH = 50;
const EMPTY_STATE: SyncState = { lastContactAt: null, block: null, chain: { seq: 0, prevHash: GENESIS } };

/** Treat "cannot reach the API" (no network, or the edge has no upstream) as offline. */
export function isOfflineError(e: unknown): boolean {
  const status = e instanceof HttpErrorResponse || e instanceof ApiError ? e.status : -1;
  return [0, 502, 503, 504].includes(status);
}

/**
 * Keeps the till usable without the API: a local copy of what it needs to sell (down-sync), and an
 * outbox of what it did offline (up-sync). Outbox entries form a hash chain signed by the device key.
 */
@Injectable({ providedIn: 'root' })
export class SyncEngine {
  private readonly http = inject(HttpClient);
  private readonly db = inject(LocalDb);
  private readonly session = inject(PosSession);
  private readonly toasts = inject(ToastService);

  readonly snapshot = signal<Snapshot | null>(null);
  readonly online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
  readonly outbox = signal(0);
  readonly lastContactAt = signal<number | null>(null);
  readonly syncing = signal(false);
  private state: SyncState = EMPTY_STATE;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private chainLock: Promise<unknown> = Promise.resolve();
  private initialized: Promise<void> | null = null;

  /** The catalog as the sell screen wants it: active products with resolved tax stacks. */
  readonly catalog = computed<PosCatalog | null>(() => {
    const s = this.snapshot();
    if (!s) return null;
    return {
      currency: s.currency,
      settings: s.settings,
      categories: Object.values(s.categories).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
      products: Object.values(s.products)
        .filter((p) => p.active)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({
          id: p.id, name: p.name, sku: p.sku, price: p.price, categoryId: p.categoryId, trackStock: p.trackStock,
          taxes: p.taxGroupId ? (s.taxGroups[p.taxGroupId]?.rates ?? []) : [],
          hasVariants: !!p.hasVariants, parentId: p.parentId ?? null, variantLabel: p.variantLabel ?? null,
          soldByWeight: !!p.soldByWeight && (s.modules ?? []).includes('weighed-items'), plu: p.plu ?? null,
          tracksBatches: !!p.tracksBatches, rxRequired: !!p.rxRequired && (s.modules ?? []).includes('prescriptions'),
          modifierGroups: (s.modules ?? []).includes('modifiers')
            ? (p.modifierGroupIds ?? []).map((id) => s.modifierGroups?.[id]).filter((g): g is ModifierGroupDef => !!g)
            : [],
        })) satisfies CatalogProduct[],
      modules: s.modules ?? [],
      promotions: (s.modules ?? []).includes('promotions') ? Object.values(s.promotions ?? {}).filter((p) => p.active) : [],
      barcodes: s.barcodes ?? {},
    };
  });

  /** Offline selling is allowed, and why not when it is not. */
  readonly offlineAllowed = computed<{ ok: true } | { ok: false; reason: string }>(() => {
    const s = this.snapshot();
    if (!s) return { ok: false, reason: 'This till has never synced, so it cannot sell offline.' };
    if (!s.settings.offline.enabled) return { ok: false, reason: 'Offline selling is turned off for this business.' };
    const last = this.lastContactAt();
    if (last === null) return { ok: false, reason: 'This till has not reached the server yet.' };
    if (Date.now() - last > s.settings.offline.maxHours * 3_600_000) {
      return { ok: false, reason: `Offline for more than ${s.settings.offline.maxHours} hours. Reconnect to keep selling.` };
    }
    return { ok: true };
  });

  /** Loads the local copy and starts the sync loop. Safe to call again (boot, then again after enrolment). */
  init(): Promise<void> {
    this.initialized ??= this.start().catch((e) => {
      this.initialized = null;
      throw e;
    });
    return this.initialized;
  }

  private async start() {
    const [snapshot, state, count] = await Promise.all([
      this.db.get<Snapshot>('kv', 'snapshot'),
      this.db.get<SyncState>('kv', 'state'),
      this.db.count('outbox'),
    ]);
    this.snapshot.set(snapshot ?? null);
    this.state = state ?? EMPTY_STATE;
    this.lastContactAt.set(this.state.lastContactAt);
    this.outbox.set(count);
    if (typeof window !== 'undefined' && !this.timer) {
      window.addEventListener('online', () => void this.syncNow());
      window.addEventListener('offline', () => this.online.set(false));
      this.timer = setInterval(() => void this.syncNow(), SYNC_EVERY_MS);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.initialized = null;
  }

  /** Pull changes, then push the outbox. Concurrent calls share one run. */
  syncNow(): Promise<void> {
    this.running ??= this.cycle().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async cycle() {
    if (!this.session.device()) return;
    this.syncing.set(true);
    try {
      await this.down();
      await this.up();
      this.online.set(true);
    } catch (e) {
      if (isOfflineError(e)) this.online.set(false);
      else throw e;
    } finally {
      this.syncing.set(false);
    }
  }

  private async saveState() {
    await this.db.put('kv', 'state', this.state);
    this.lastContactAt.set(this.state.lastContactAt);
  }

  private async down() {
    const s = this.snapshot();
    const cursor = s?.cursor ?? '0';
    const blockNext = this.state.block?.next;
    const r = await firstValueFrom(
      this.http.get<DownResponse>(`/api/pos/sync/down?cursor=${cursor}${blockNext !== undefined ? `&blockNext=${blockNext}` : ''}`),
    );
    const base: Snapshot = r.full || !s
      ? {
          cursor: '0', currency: r.currency, timezone: r.timezone, tenantName: r.tenantName, settings: r.settings, register: r.register,
          users: [], categories: {}, products: {}, taxGroups: {}, shift: null, modules: [], barcodes: {}, promotions: {}, modifierGroups: {},
        }
      : { ...s, barcodes: s.barcodes ?? {}, promotions: s.promotions ?? {}, modules: s.modules ?? [], modifierGroups: s.modifierGroups ?? {} };
    // A product in the delta brings its complete list of codes: drop what it had, then add.
    const touched = new Set(r.products.map((p) => p.id));
    const barcodes = Object.fromEntries(Object.entries(base.barcodes).filter(([, pid]) => !touched.has(pid)));
    for (const b of r.barcodes ?? []) barcodes[b.code] = b.productId;
    const next: Snapshot = {
      ...base,
      cursor: r.cursor,
      currency: r.currency,
      timezone: r.timezone,
      tenantName: r.tenantName,
      settings: r.settings,
      register: r.register,
      users: r.users,
      shift: r.shift,
      categories: { ...base.categories, ...Object.fromEntries(r.categories.map((c) => [c.id, c])) },
      products: { ...base.products, ...Object.fromEntries(r.products.map((p) => [p.id, p])) },
      taxGroups: { ...base.taxGroups, ...Object.fromEntries(r.taxGroups.map((g) => [g.id, g])) },
      modules: r.modules ?? [],
      barcodes,
      promotions: { ...base.promotions, ...Object.fromEntries((r.promotions ?? []).map((p) => [p.id, p])) },
      modifierGroups: { ...base.modifierGroups, ...Object.fromEntries((r.modifierGroups ?? []).map((g) => [g.id, g])) },
    };
    await this.db.put('kv', 'snapshot', next);
    this.snapshot.set(next);
    const block = this.state.block;
    const sameBlock = block && block.start === r.receiptBlock.start && block.end === r.receiptBlock.end;
    this.state = {
      ...this.state,
      lastContactAt: Date.now(),
      block: sameBlock ? block : { ...r.receiptBlock, next: r.receiptBlock.start },
    };
    await this.saveState();
  }

  private async up() {
    for (;;) {
      const batch = await this.db.all<OfflineOp>('outbox', BATCH);
      if (!batch.length) break;
      const res = await firstValueFrom(this.http.post<{ results: SyncResult[] }>('/api/pos/sync/up', { ops: batch.map((b) => b.value) }));
      const quarantined = res.results.filter((r) => r.status === 'quarantined');
      for (const b of batch) await this.db.delete('outbox', b.key);
      this.outbox.set(await this.db.count('outbox'));
      if (quarantined.length) {
        this.toasts.error(`${quarantined.length} offline ${quarantined.length === 1 ? 'entry was' : 'entries were'} held for a manager to review.`);
      }
      this.state = { ...this.state, lastContactAt: Date.now() };
      await this.saveState();
      if (batch.length < BATCH) break;
    }
  }

  /** Takes the next offline receipt number from this device's reserved block. */
  async nextReceiptNo(): Promise<string> {
    const b = this.state.block;
    const code = this.snapshot()?.register.code;
    if (!b || !code || b.next > b.end) throw new Error('No offline receipt numbers left. Reconnect to get more.');
    const n = b.next;
    this.state = { ...this.state, block: { ...b, next: n + 1 } };
    await this.saveState();
    return offlineReceiptNo(code, n);
  }

  /** Appends a signed, chained op to the outbox. Ops are chained one at a time, in order. */
  enqueue(kind: OfflineOpKind, payload: OfflineOp['payload']): Promise<OfflineOp> {
    const next = this.chainLock.then(async () => {
      const device = this.session.device();
      if (!device) throw new Error('Till not enrolled');
      const seq = this.state.chain.seq + 1;
      const unsigned = { kind, seq, prevHash: this.state.chain.prevHash, createdAt: new Date().toISOString(), payload } as Omit<OfflineOp, 'hash' | 'sig'>;
      const hash = await opHash(unsigned as OfflineOp);
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, new TextEncoder().encode(hash));
      const op = { ...unsigned, hash, sig: bytesToBase64Url(new Uint8Array(sig)) } as OfflineOp;
      await this.db.put('outbox', seq, op);
      this.state = { ...this.state, chain: { seq, prevHash: hash } };
      await this.saveState();
      this.outbox.set(await this.db.count('outbox'));
      return op;
    });
    this.chainLock = next.catch(() => undefined);
    void next.then(() => {
      if (this.online()) void this.syncNow().catch(() => undefined);
    });
    return next;
  }

  user(id: string): SnapUser | undefined {
    return this.snapshot()?.users.find((u) => u.id === id);
  }

  /** Keeps the local copy of the open shift current after online actions. */
  async setShift(shift: ShiftReport | null) {
    const s = this.snapshot();
    if (!s) return;
    const next = { ...s, shift };
    this.snapshot.set(next);
    await this.db.put('kv', 'snapshot', next);
  }

  async wipe() {
    this.stop();
    await this.db.clear().catch(() => undefined);
    this.state = EMPTY_STATE;
    this.snapshot.set(null);
    this.outbox.set(0);
    this.lastContactAt.set(null);
  }
}
