import { inject, Injectable, signal } from '@angular/core';
import { formatMinor, formatQty, parseMinor } from '@pos/shared';
import { CommerceApi } from './commerce-api';

/** The tenant's currency, loaded once, for formatting and parsing amounts in the back office. */
@Injectable({ providedIn: 'root' })
export class Money {
  private readonly api = inject(CommerceApi);
  readonly currency = signal('LKR');
  private loaded: Promise<void> | null = null;

  constructor() {
    this.load();
  }

  load() {
    this.loaded ??= this.api
      .settings()
      .then((s) => this.currency.set(s.currency))
      .catch(() => {
        this.loaded = null;
      });
    return this.loaded;
  }

  fmt(amount: number | null | undefined) {
    return amount === null || amount === undefined ? '—' : formatMinor(amount, this.currency());
  }
  parse(text: string) {
    return parseMinor(text, this.currency());
  }
  qty(qtyMilli: number) {
    return formatQty(qtyMilli);
  }
  pct(bp: number) {
    return `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`;
  }
}
