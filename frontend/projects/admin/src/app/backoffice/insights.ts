import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiEmpty } from 'ui';
import { BackofficeApi } from './backoffice-api';
import { localDate } from './local-date';
import { Money } from './money';

type By = 'store' | 'category' | 'cashier' | 'hour' | 'product';
interface Row {
  key: string;
  label: string;
  sales: number;
  qtyMilli: number;
  revenue: number;
  cost: number;
  margin: number;
}
interface Inventory {
  totalValue: number;
  rows: { productId: string; name: string; qtyMilli: number; unitCost: number; value: number; low: boolean; negative: boolean; reorderPoint: number | null }[];
  low: { productId: string; name: string; qtyMilli: number; reorderPoint: number | null }[];
}

const BY: { key: By; label: string }[] = [
  { key: 'product', label: 'Product' },
  { key: 'category', label: 'Category' },
  { key: 'store', label: 'Store' },
  { key: 'cashier', label: 'Staff' },
  { key: 'hour', label: 'Hour of day' },
];

/** Margin by dimension, stock value and low stock, and a CSV export of sale lines. */
@Component({
  selector: 'admin-insights',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiEmpty],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Insights</h1>
        <div class="row">
          <label class="small">From <input type="date" [value]="from()" (change)="from.set(val($event))" /></label>
          <label class="small">To <input type="date" [value]="to()" (change)="to.set(val($event))" /></label>
          <button class="btn" type="button" data-testid="export-csv" (click)="exportCsv()">Export CSV</button>
        </div>
      </div>
      <div class="row">
        @for (b of byOptions; track b.key) {
          <button type="button" class="btn small" [class.primary]="by() === b.key" (click)="by.set(b.key)">{{ b.label }}</button>
        }
      </div>
      <section class="card flush">
        @if (rows.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>{{ byLabel() }}</th><th class="num">Sales</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Margin</th><th class="num">Margin %</th></tr></thead>
            <tbody>
              @for (r of rows.value(); track r.key) {
                <tr [attr.data-row]="r.label">
                  <td>{{ r.label }}</td><td class="num">{{ r.sales }}</td><td class="num">{{ money.fmt(r.revenue) }}</td><td class="num">{{ money.fmt(r.cost) }}</td>
                  <td class="num">{{ money.fmt(r.margin) }}</td><td class="num">{{ r.revenue ? ((r.margin / r.revenue) * 100).toFixed(1) + '%' : '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="rows.errorMessage() ?? (rows.isLoading() ? 'Loading…' : 'No sales in this period')" />
        }
      </section>

      <div class="row-between">
        <h2>Stock value</h2>
        <select aria-label="Store" [value]="storeId()" (change)="storeId.set(val($event))" style="max-width: 260px">
          @for (s of stores.value() ?? []; track s.id) { <option [value]="s.id">{{ s.code }} · {{ s.name }}</option> }
        </select>
      </div>
      @if (inventory.value(); as inv) {
        <section class="card stack">
          <div>At cost: <strong data-testid="stock-value">{{ money.fmt(inv.totalValue) }}</strong></div>
          @if (inv.low.length) {
            <div><strong>Low stock</strong></div>
            @for (l of inv.low; track l.productId) {
              <div class="row-between small" [attr.data-low]="l.name"><span>{{ l.name }} <ui-badge tone="warn">{{ money.qty(l.qtyMilli) }} left</ui-badge></span><span class="muted">reorder at {{ money.qty(l.reorderPoint ?? 0) }}</span></div>
            }
          } @else {
            <div class="muted small">Nothing below its reorder point.</div>
          }
        </section>
      }
    </div>
  `,
  styles: `.num { text-align: right; }`,
})
export class Insights {
  private readonly http = inject(HttpClient);
  private readonly bo = inject(BackofficeApi);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly byOptions = BY;
  protected readonly by = signal<By>('product');
  protected readonly from = signal(localDate(new Date(Date.now() - 29 * 86_400_000)));
  protected readonly to = signal(localDate(new Date()));
  protected readonly storeId = signal('');
  protected readonly stores = apiResource({
    loader: async () => {
      const list = await this.bo.stores();
      if (!this.storeId() && list[0]) this.storeId.set(list[0].id);
      return list;
    },
  });
  protected readonly rows = apiResource({
    params: () => ({ by: this.by(), ...this.range() }),
    loader: ({ params }) => firstValueFrom(this.http.get<Row[]>(`/api/reports/breakdown?by=${params.by}&from=${encodeURIComponent(params.from)}&to=${encodeURIComponent(params.to)}`)),
  });
  protected readonly inventory = apiResource({
    params: () => this.storeId() || undefined,
    loader: ({ params }) => firstValueFrom(this.http.get<Inventory>(`/api/reports/inventory?storeId=${params}`)),
  });

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected byLabel() {
    return BY.find((b) => b.key === this.by())?.label ?? '';
  }
  private range() {
    const f = new Date(`${this.from()}T00:00:00`);
    const t = new Date(`${this.to()}T00:00:00`);
    t.setDate(t.getDate() + 1);
    return { from: f.toISOString(), to: t.toISOString() };
  }

  protected async exportCsv() {
    const r = this.range();
    try {
      const blob = await firstValueFrom(this.http.get(`/api/reports/sales.csv?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`, { responseType: 'blob' }));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sales-${this.from()}-${this.to()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
