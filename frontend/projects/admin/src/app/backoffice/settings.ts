import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { parseSettings, type TenantSettings } from '@pos/shared';
import { humanMessage, toApiError, ToastService, UiField } from 'ui';
import { CommerceApi } from './commerce-api';
import { Money } from './money';

@Component({
  selector: 'admin-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiField],
  template: `
    <div class="page stack">
      <h1>Settings</h1>
      @if (s(); as v) {
        <form class="stack" (submit)="$event.preventDefault(); save()">
          <section class="card stack">
            <h2>Prices and tax</h2>
            <label class="check"><input type="checkbox" [checked]="v.pricesIncludeTax" (change)="patch({ pricesIncludeTax: checked($event) })" /> Shelf prices include tax</label>
            <ui-field label="Cash rounding" for="s-round" hint="All-cash totals round to the nearest step. 1 = no rounding.">
              <select id="s-round" [value]="v.cashRoundingUnit" (change)="patch({ cashRoundingUnit: +val($event) })" style="max-width: 240px">
                <option [value]="1">No rounding</option>
                <option [value]="100">Nearest 1.00</option>
                <option [value]="500">Nearest 5.00</option>
                <option [value]="1000">Nearest 10.00</option>
              </select>
            </ui-field>
          </section>
          <section class="card stack">
            <h2>Manager approval</h2>
            <ui-field label="Refunds above" for="s-refund" [hint]="'In ' + money.currency() + '. 0 = every refund needs a manager PIN.'">
              <input id="s-refund" inputmode="decimal" [value]="money.fmt(v.stepUp.refundAbove).replace(',', '')" (change)="setRefund(val($event))" style="max-width: 200px" />
            </ui-field>
            <ui-field label="Discounts above (%)" for="s-disc" hint="Staff with the discount permission can give up to this much on their own.">
              <input id="s-disc" inputmode="decimal" [value]="v.stepUp.discountAboveBp / 100" (change)="setDiscount(val($event))" style="max-width: 120px" />
            </ui-field>
            <p class="small muted">Voids, price changes and opening the drawer without a sale always need a manager.</p>
          </section>
          <section class="card stack">
            <h2>Receipts</h2>
            <ui-field label="Header" for="s-head" hint="Address, phone, VAT registration number."><textarea id="s-head" rows="3" [value]="v.receipt.header" (change)="patchReceipt({ header: val($event) })"></textarea></ui-field>
            <ui-field label="Footer" for="s-foot"><textarea id="s-foot" rows="2" [value]="v.receipt.footer" (change)="patchReceipt({ footer: val($event) })"></textarea></ui-field>
            <label class="check"><input type="checkbox" [checked]="v.receipt.showTaxBreakdown" (change)="patchReceipt({ showTaxBreakdown: checked($event) })" /> Show the tax breakdown</label>
          </section>
          <div><button class="btn primary" type="submit" [disabled]="busy()">Save settings</button></div>
        </form>
      } @else {
        <p class="muted">Loading…</p>
      }
    </div>
  `,
  styles: `.check { display: flex; gap: var(--s2); align-items: center; }`,
})
export class Settings {
  private readonly api = inject(CommerceApi);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly s = signal<TenantSettings | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    void this.api.settings().then((r) => this.s.set(parseSettings(r)));
  }

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected checked(e: Event) {
    return (e.target as HTMLInputElement).checked;
  }
  protected patch(p: Partial<TenantSettings>) {
    this.s.update((v) => (v ? { ...v, ...p } : v));
  }
  protected patchReceipt(p: Partial<TenantSettings['receipt']>) {
    this.s.update((v) => (v ? { ...v, receipt: { ...v.receipt, ...p } } : v));
  }
  protected setRefund(text: string) {
    const amount = this.money.parse(text);
    if (amount !== null) this.s.update((v) => (v ? { ...v, stepUp: { ...v.stepUp, refundAbove: amount } } : v));
  }
  protected setDiscount(text: string) {
    const n = Number(text);
    if (Number.isFinite(n) && n >= 0 && n <= 100) this.s.update((v) => (v ? { ...v, stepUp: { ...v.stepUp, discountAboveBp: Math.round(n * 100) } } : v));
  }

  protected async save() {
    const v = this.s();
    if (!v) return;
    this.busy.set(true);
    try {
      this.s.set(parseSettings(await this.api.saveSettings(v)));
      this.toasts.success('Settings saved');
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    } finally {
      this.busy.set(false);
    }
  }
}
