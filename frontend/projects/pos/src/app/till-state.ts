import { computed, inject, Injectable, signal } from '@angular/core';
import { formatMinor, formatQty, parseMinor } from '@pos/shared';
import { type PosCatalog, PosApi, type ShiftReport } from './api/pos-api';
import { Cart } from './sell/cart';

/** What the till knows right now: catalog, the open shift, who is signed in. */
@Injectable({ providedIn: 'root' })
export class TillState {
  private readonly api = inject(PosApi);
  private readonly cart = inject(Cart);

  readonly catalog = signal<PosCatalog | null>(null);
  readonly shift = signal<ShiftReport | null>(null);
  readonly cashier = signal<{ id: string; name: string } | null>(null);
  readonly tenantName = signal('');
  readonly loaded = signal(false);
  readonly error = signal<unknown>(null);

  readonly currency = computed(() => this.catalog()?.currency ?? 'LKR');
  readonly shiftOpen = computed(() => this.shift()?.shift.status === 'OPEN');

  async load() {
    this.error.set(null);
    try {
      const [catalog, shift, me] = await Promise.all([this.api.catalog(), this.api.shift(), this.api.me()]);
      this.catalog.set(catalog);
      this.cart.settings.set(catalog.settings);
      this.shift.set(shift.shift);
      this.cashier.set(me.user);
      this.tenantName.set(me.tenant.name);
      this.loaded.set(true);
    } catch (e) {
      this.error.set(e);
    }
  }

  async refreshShift() {
    this.shift.set((await this.api.shift()).shift);
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
