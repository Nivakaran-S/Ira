import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { BackofficeSession } from './session';
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
          @if (loyaltyOn()) {
            <section class="card stack">
              <h2>Loyalty</h2>
              <div class="grid-2">
                <ui-field label="Spend for one point" for="s-earn" [hint]="'In ' + money.currency()">
                  <input id="s-earn" inputmode="decimal" [value]="money.fmt(v.loyalty.earnSpend).replace(',', '')" (change)="setLoyalty('earnSpend', val($event))" />
                </ui-field>
                <ui-field label="Value of one point" for="s-pv" [hint]="'In ' + money.currency()">
                  <input id="s-pv" inputmode="decimal" [value]="money.fmt(v.loyalty.pointValue).replace(',', '')" (change)="setLoyalty('pointValue', val($event))" />
                </ui-field>
                <ui-field label="Smallest redemption (points)" for="s-min">
                  <input id="s-min" inputmode="numeric" [value]="v.loyalty.minRedeemPoints" (change)="setMinRedeem(val($event))" />
                </ui-field>
              </div>
            </section>
          }
          @if (has('weighed-items')) {
            <section class="card stack">
              <h2>Scale labels</h2>
              <label class="check"><input type="checkbox" [checked]="v.scaleBarcode.enabled" (change)="patch({ scaleBarcode: { ...v.scaleBarcode, enabled: checked($event) } })" /> Read price or weight from in-store scale labels (EAN-13)</label>
              <div class="row">
                <ui-field label="Prefix" for="s-sb-p"><input id="s-sb-p" [value]="v.scaleBarcode.prefix" (change)="patch({ scaleBarcode: { ...v.scaleBarcode, prefix: val($event) } })" style="max-width: 80px" /></ui-field>
                <ui-field label="PLU digits" for="s-sb-d"><input id="s-sb-d" inputmode="numeric" [value]="v.scaleBarcode.pluDigits" (change)="patch({ scaleBarcode: { ...v.scaleBarcode, pluDigits: +val($event) || 5 } })" style="max-width: 80px" /></ui-field>
                <ui-field label="Value is" for="s-sb-v">
                  <select id="s-sb-v" [value]="v.scaleBarcode.valueType" (change)="patch({ scaleBarcode: { ...v.scaleBarcode, valueType: val($event) === 'price' ? 'price' : 'weight' } })">
                    <option value="weight">Weight (grams)</option>
                    <option value="price">Price</option>
                  </select>
                </ui-field>
              </div>
            </section>
          }
          @if (has('batch-expiry') || has('prescriptions')) {
            <section class="card stack">
              <h2>Pharmacy</h2>
              <div class="row">
                <ui-field label="Prescriptions valid for (days)" for="s-rx"><input id="s-rx" inputmode="numeric" [value]="v.pharmacy.rxValidDays" (change)="patch({ pharmacy: { ...v.pharmacy, rxValidDays: +val($event) || 30 } })" style="max-width: 100px" /></ui-field>
                <ui-field label="Warn about expiry (days)" for="s-exp"><input id="s-exp" inputmode="numeric" [value]="v.pharmacy.expiryWarnDays" (change)="patch({ pharmacy: { ...v.pharmacy, expiryWarnDays: +val($event) || 30 } })" style="max-width: 100px" /></ui-field>
              </div>
            </section>
          }
          <section class="card stack">
            <h2>Offline selling</h2>
            <label class="check"><input type="checkbox" [checked]="v.offline.enabled" (change)="patch({ offline: { ...v.offline, enabled: checked($event) } })" /> Tills keep selling without a connection</label>
            <ui-field label="Longest time offline (hours)" for="s-off-h"><input id="s-off-h" inputmode="numeric" [value]="v.offline.maxHours" (change)="patch({ offline: { ...v.offline, maxHours: +val($event) || 24 } })" style="max-width: 120px" /></ui-field>
            <ui-field label="Largest refund offline" for="s-off-refund" [hint]="'In ' + money.currency() + '. 0 = refunds need a connection.'">
              <input id="s-off-refund" inputmode="decimal" [value]="money.fmt(v.offline.maxRefund).replaceAll(',', '')" (change)="setOfflineRefund(val($event))" style="max-width: 200px" />
            </ui-field>
            <label class="check"><input type="checkbox" [checked]="v.offline.allowCard" (change)="patch({ offline: { ...v.offline, allowCard: checked($event) } })" /> Accept keyed-in card and other payments offline</label>
            <p class="small muted">Cards charged on a card terminal connected to the till, cash, points and store credit are always accepted offline.</p>
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
  private readonly session = inject(BackofficeSession);
  protected readonly loyaltyOn = computed(() => this.session.modules().includes('loyalty'));
  protected has(module: string) {
    return this.session.modules().includes(module);
  }

  protected setLoyalty(key: 'earnSpend' | 'pointValue', text: string) {
    const v = this.money.parse(text);
    if (v && v > 0) this.s.update((x) => (x ? { ...x, loyalty: { ...x.loyalty, [key]: v } } : x));
  }
  protected setMinRedeem(text: string) {
    const n = Math.trunc(Number(text));
    if (n >= 1) this.s.update((x) => (x ? { ...x, loyalty: { ...x.loyalty, minRedeemPoints: n } } : x));
  }

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
  protected setOfflineRefund(text: string) {
    const amount = this.money.parse(text);
    if (amount !== null) this.s.update((v) => (v ? { ...v, offline: { ...v.offline, maxRefund: amount } } : v));
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
