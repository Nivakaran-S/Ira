import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiResource, humanMessage, toApiError, ToastService, UiEmpty } from 'ui';
import { BackofficeApi } from './backoffice-api';
import { CommerceApi } from './commerce-api';
import { Money } from './money';

/** A store's own prices. Blank = the catalog price. */
@Component({
  selector: 'admin-store-prices',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiEmpty],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Store prices</h1>
        <select aria-label="Store" [value]="storeId()" (change)="storeId.set(val($event))" style="max-width: 260px">
          @for (s of stores.value() ?? []; track s.id) { <option [value]="s.id">{{ s.code }} · {{ s.name }}</option> }
        </select>
      </div>
      <section class="card flush">
        @if (products().length) {
          <table class="ui-table">
            <thead><tr><th>Product</th><th class="num">Catalog price</th><th>This store</th></tr></thead>
            <tbody>
              @for (p of products(); track p.id) {
                <tr [attr.data-price-row]="p.name">
                  <td>{{ p.name }}</td>
                  <td class="num">{{ money.fmt(p.price) }}</td>
                  <td><input [attr.aria-label]="'Store price ' + p.name" inputmode="decimal" placeholder="Catalog" [value]="edits()[p.id] ?? current(p.id)" (input)="edit(p.id, val($event))" style="max-width: 140px" /></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty title="No products" />
        }
      </section>
      <div><button class="btn primary" type="button" data-testid="save-prices" [disabled]="!dirty()" (click)="save()">Save prices</button></div>
    </div>
  `,
  styles: `.num { text-align: right; }`,
})
export class StorePrices {
  private readonly http = inject(HttpClient);
  private readonly bo = inject(BackofficeApi);
  private readonly commerce = inject(CommerceApi);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly stores = apiResource({
    loader: async () => {
      const list = await this.bo.stores();
      if (!this.storeId() && list[0]) this.storeId.set(list[0].id);
      return list;
    },
  });
  protected readonly storeId = signal('');
  private readonly all = apiResource({ loader: () => this.commerce.products(false) });
  protected readonly products = computed(() => (this.all.value() ?? []).filter((p) => !(p as { hasVariants?: boolean }).hasVariants));
  private readonly prices = apiResource({
    params: () => this.storeId() || undefined,
    loader: ({ params }) => firstValueFrom(this.http.get<{ productId: string; price: number }[]>(`/api/stores/${params}/prices`)),
  });
  protected readonly edits = signal<Record<string, string>>({});
  protected readonly dirty = computed(() => Object.keys(this.edits()).length > 0);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected current(productId: string) {
    const p = this.prices.value()?.find((x) => x.productId === productId);
    return p ? this.money.fmt(p.price).replace(/,/g, '') : '';
  }
  protected edit(id: string, v: string) {
    this.edits.update((e) => ({ ...e, [id]: v }));
  }

  protected async save() {
    const prices = Object.entries(this.edits()).map(([productId, v]) => ({ productId, price: v.trim() ? this.money.parse(v) : null }));
    if (prices.some((p) => p.price === undefined)) return;
    try {
      await firstValueFrom(this.http.put(`/api/stores/${this.storeId()}/prices`, { prices }));
      this.toasts.success('Store prices saved; tills pick them up on their next sync');
      this.edits.set({});
      this.prices.reload();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
