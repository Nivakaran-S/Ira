import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { apiResource, humanMessage, toApiError, ToastService, UiDialog, UiEmpty, UiField } from 'ui';
import { BackofficeApi } from './backoffice-api';
import { CommerceApi, type StockRow } from './commerce-api';
import { Money } from './money';

@Component({
  selector: 'admin-stock',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Stock</h1>
        <select aria-label="Store" [value]="storeId()" (change)="storeId.set(val($event))" style="max-width: 260px">
          @for (s of stores.value() ?? []; track s.id) { <option [value]="s.id">{{ s.code }} · {{ s.name }}</option> }
        </select>
      </div>
      <section class="card flush">
        @if (rows.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Product</th><th>SKU</th><th class="num">On hand</th><th></th></tr></thead>
            <tbody>
              @for (r of rows.value(); track r.id) {
                <tr [class.neg]="r.qtyMilli < 0">
                  <td>{{ r.name }}</td>
                  <td class="mono small">{{ r.sku ?? '—' }}</td>
                  <td class="num">{{ money.qty(r.qtyMilli) }} @if (r.qtyMilli < 0) { <span class="small">(negative)</span> }</td>
                  <td><button class="btn small" type="button" (click)="adjusting.set(r)">Adjust</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="rows.errorMessage() ?? (!storeId() ? 'Add a store first' : rows.isLoading() ? 'Loading…' : 'No stocked products')" />
        }
      </section>
    </div>

    <ui-dialog [title]="'Adjust ' + (adjusting()?.name ?? '')" [open]="!!adjusting()" (closed)="adjusting.set(null)">
      <form class="stack" (submit)="$event.preventDefault(); adjust()">
        <ui-field label="Change" for="a-delta" hint="Positive to add (received, found), negative to remove (damaged, lost).">
          <input id="a-delta" inputmode="decimal" [value]="delta()" (input)="delta.set(val($event))" />
        </ui-field>
        <ui-field label="Reason" for="a-note"><input id="a-note" [value]="note()" (input)="note.set(val($event))" /></ui-field>
        <div><button class="btn primary" type="submit" [disabled]="!valid()">Save</button></div>
      </form>
    </ui-dialog>
  `,
  styles: `.num { text-align: right; } tr.neg td { color: var(--danger); }`,
})
export class Stock {
  private readonly api = inject(CommerceApi);
  private readonly bo = inject(BackofficeApi);
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
  protected readonly rows = apiResource({ params: () => this.storeId() || undefined, loader: ({ params }) => this.api.stock(params) });
  protected readonly adjusting = signal<StockRow | null>(null);
  protected readonly delta = signal('');
  protected readonly note = signal('');
  private readonly deltaMilli = computed(() => {
    const n = Number(this.delta());
    return this.delta().trim() && Number.isFinite(n) && n !== 0 ? Math.round(n * 1000) : null;
  });
  protected readonly valid = computed(() => this.deltaMilli() !== null && !!this.note().trim());

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async adjust() {
    const row = this.adjusting();
    if (!row) return;
    try {
      await this.api.adjustStock({ storeId: this.storeId(), productId: row.id, deltaMilli: this.deltaMilli()!, note: this.note().trim() });
      this.toasts.success('Stock updated');
      this.adjusting.set(null);
      this.delta.set('');
      this.note.set('');
      this.rows.reload();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
