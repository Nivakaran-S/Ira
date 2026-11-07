import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { formatMinor, formatQty, parseMinor } from '@pos/shared';
import { PosApi, type ShiftReport } from './api/pos-api';
import { PosSession } from './device/pos-session';
import { isOfflineError, SyncEngine } from './offline/sync-engine';
import { Cart } from './sell/cart';

/**
 * What the till knows right now: catalog (from the offline copy), the open shift, who is signed in.
 * Online, shift and cashier come from the API; offline, from the last sync and the local sign-in.
 */
@Injectable({ providedIn: 'root' })
export class TillState {
  private readonly api = inject(PosApi);
  private readonly cart = inject(Cart);
  private readonly session = inject(PosSession);
  readonly sync = inject(SyncEngine);

  readonly catalog = this.sync.catalog;
  readonly shift = signal<ShiftReport | null>(null);
  readonly cashier = signal<{ id: string; name: string } | null>(null);
  readonly tenantName = signal('');
  readonly loaded = signal(false);
  readonly error = signal<unknown>(null);

  readonly currency = computed(() => this.catalog()?.currency ?? 'LKR');
  readonly shiftOpen = computed(() => this.shift()?.shift.status === 'OPEN');
  /** Selling goes through the outbox: nobody holds an API session, or the API is unreachable. */
  readonly offline = computed(() => !this.session.accessToken() || !this.sync.online());

  constructor() {
    effect(() => this.cart.settings.set(this.catalog()?.settings ?? null));
  }

  async load() {
    this.error.set(null);
    await this.sync.init();
    await this.sync.syncNow().catch(() => undefined);
    const snap = this.sync.snapshot();
    const offlineUser = this.session.offlineUser();
    try {
      if (offlineUser || !this.session.accessToken()) throw Object.assign(new Error('offline session'), { offlineSession: true });
      const [shift, me] = await Promise.all([this.api.shift(), this.api.me()]);
      this.shift.set(shift.shift);
      this.cashier.set(me.user);
      this.tenantName.set(me.tenant.name);
      await this.sync.setShift(shift.shift);
    } catch (e) {
      if (!(e as { offlineSession?: boolean }).offlineSession && !isOfflineError(e)) {
        this.error.set(e);
        return;
      }
      this.shift.set(snap?.shift ?? null);
      this.cashier.set(offlineUser);
      this.tenantName.set(snap?.tenantName ?? '');
    }
    if (!this.catalog()) {
      this.error.set(new Error('This till has no catalog yet. Connect it to the internet once.'));
      return;
    }
    this.loaded.set(true);
  }

  async refreshShift() {
    if (this.offline()) return;
    try {
      const s = (await this.api.shift()).shift;
      this.shift.set(s);
      await this.sync.setShift(s);
    } catch (e) {
      if (!isOfflineError(e)) throw e;
    }
  }

  async setShift(s: ShiftReport | null) {
    this.shift.set(s);
    await this.sync.setShift(s);
  }

  reset() {
    this.loaded.set(false);
    this.shift.set(null);
    this.cashier.set(null);
    this.cart.clear();
  }

  money(amount: number) {
    return formatMinor(amount, this.currency());
  }
  qty(qtyMilli: number) {
    return formatQty(qtyMilli);
  }
  parse(text: string) {
    return parseMinor(text, this.currency());
  }
}
