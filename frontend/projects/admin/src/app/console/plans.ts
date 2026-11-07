import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { formatMinor, parseMinor } from '@pos/shared';
import { apiResource, fieldErrors, humanMessage, toApiError, ToastService, UiDialog, UiEmpty, UiField } from 'ui';
import { BillingApi, type Plan } from './billing-api';

@Component({
  selector: 'admin-plans',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Plans</h1>
        <button class="btn primary" type="button" data-testid="new-plan" (click)="edit(null)">New plan</button>
      </div>
      <section class="card flush">
        @if (plans.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Plan</th><th>Price / month</th><th>Stores</th><th>Devices</th><th>Users</th><th>Products</th><th>Tenants</th><th></th></tr></thead>
            <tbody>
              @for (p of plans.value(); track p.id) {
                <tr [attr.data-plan]="p.key">
                  <td>{{ p.name }} <span class="muted mono small">{{ p.key }}</span></td>
                  <td>{{ p.priceMonthly ? p.currency + ' ' + money(p.priceMonthly, p.currency) : 'Free' }}</td>
                  <td>{{ p.maxStores }}</td><td>{{ p.maxDevices }}</td><td>{{ p.maxUsers }}</td><td>{{ p.maxProducts }}</td>
                  <td>{{ p._count?.tenants ?? 0 }}</td>
                  <td><button class="btn small" type="button" (click)="edit(p)">Edit</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="plans.errorMessage() ?? 'Loading…'" />
        }
      </section>
    </div>

    <ui-dialog [title]="editing() ? 'Edit plan' : 'New plan'" [open]="open()" (closed)="open.set(false)">
      <form class="stack" data-testid="plan-form" (submit)="$event.preventDefault(); save()">
        <div class="grid-2">
          <ui-field label="Key" for="p-key" [error]="errors()['key']"><input id="p-key" [disabled]="!!editing()" [value]="f().key" (input)="set('key', val($event))" /></ui-field>
          <ui-field label="Name" for="p-name"><input id="p-name" [value]="f().name" (input)="set('name', val($event))" /></ui-field>
          <ui-field label="Monthly price" for="p-price"><input id="p-price" inputmode="decimal" [value]="f().price" (input)="set('price', val($event))" /></ui-field>
          <ui-field label="Currency" for="p-cur"><input id="p-cur" [value]="f().currency" (input)="set('currency', val($event))" /></ui-field>
          <ui-field label="Stores" for="p-st"><input id="p-st" inputmode="numeric" [value]="f().maxStores" (input)="set('maxStores', val($event))" /></ui-field>
          <ui-field label="Devices" for="p-dv"><input id="p-dv" inputmode="numeric" [value]="f().maxDevices" (input)="set('maxDevices', val($event))" /></ui-field>
          <ui-field label="Users" for="p-us"><input id="p-us" inputmode="numeric" [value]="f().maxUsers" (input)="set('maxUsers', val($event))" /></ui-field>
          <ui-field label="Products" for="p-pr"><input id="p-pr" inputmode="numeric" [value]="f().maxProducts" (input)="set('maxProducts', val($event))" /></ui-field>
          <ui-field label="Grace days before suspension" for="p-gr"><input id="p-gr" inputmode="numeric" [value]="f().graceDays" (input)="set('graceDays', val($event))" /></ui-field>
        </div>
        <div><button class="btn primary" type="submit">Save plan</button></div>
      </form>
    </ui-dialog>
  `,
})
export class Plans {
  private readonly api = inject(BillingApi);
  private readonly toasts = inject(ToastService);
  protected readonly plans = apiResource({ loader: () => this.api.plans() });
  protected readonly open = signal(false);
  protected readonly editing = signal<Plan | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly f = signal({ key: '', name: '', price: '0', currency: 'LKR', maxStores: '1', maxDevices: '5', maxUsers: '10', maxProducts: '1000', graceDays: '15' });

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected money(n: number, c: string) {
    return formatMinor(n, c);
  }
  protected set(k: string, v: string) {
    this.f.update((x) => ({ ...x, [k]: v }));
  }

  protected edit(p: Plan | null) {
    this.editing.set(p);
    this.errors.set({});
    this.f.set(
      p
        ? { key: p.key, name: p.name, price: formatMinor(p.priceMonthly, p.currency).replace(/,/g, ''), currency: p.currency, maxStores: String(p.maxStores), maxDevices: String(p.maxDevices), maxUsers: String(p.maxUsers), maxProducts: String(p.maxProducts), graceDays: String(p.graceDays) }
        : { key: '', name: '', price: '0', currency: 'LKR', maxStores: '1', maxDevices: '5', maxUsers: '10', maxProducts: '1000', graceDays: '15' },
    );
    this.open.set(true);
  }

  protected async save() {
    const v = this.f();
    try {
      await this.api.savePlan({
        key: v.key.trim(), name: v.name.trim(), priceMonthly: parseMinor(v.price, v.currency) ?? 0, currency: v.currency.trim().toUpperCase(),
        maxStores: +v.maxStores, maxDevices: +v.maxDevices, maxUsers: +v.maxUsers, maxProducts: +v.maxProducts, graceDays: +v.graceDays,
      });
      this.toasts.success('Plan saved');
      this.open.set(false);
      this.plans.reload();
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.toasts.error(humanMessage(err));
    }
  }
}
