import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { formatMinor } from '@pos/shared';
import { firstValueFrom } from 'rxjs';
import { apiResource, UiBadge, UiEmpty } from 'ui';

interface Billing {
  plan: { key: string; name: string; priceMonthly: number; currency: string };
  limits: Record<'stores' | 'devices' | 'users' | 'products', number>;
  usage: Record<'stores' | 'devices' | 'users' | 'products', number>;
  invoices: { id: string; number: string; periodStart: string; periodEnd: string; dueOn: string; amount: number; currency: string; status: string; paidRef: string | null }[];
}

/** The business's plan, how much of it is used, and its invoices. */
@Component({
  selector: 'admin-billing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiEmpty],
  template: `
    <div class="page stack">
      <h1>Plan and billing</h1>
      @if (data.value(); as b) {
        <section class="card stack">
          <div class="row-between">
            <h2 data-testid="plan-name">{{ b.plan.name }}</h2>
            <strong>{{ b.plan.priceMonthly ? b.plan.currency + ' ' + money(b.plan.priceMonthly, b.plan.currency) + ' / month' : 'Free' }}</strong>
          </div>
          @for (k of keys; track k) {
            <div class="usage">
              <span class="label">{{ k }}</span>
              <div class="bar"><div class="fill" [class.full]="b.usage[k] >= b.limits[k]" [style.width.%]="pct(b.usage[k], b.limits[k])"></div></div>
              <span class="small" [attr.data-usage]="k">{{ b.usage[k] }} of {{ b.limits[k] }}</span>
            </div>
          }
          <p class="small muted">To change plan, contact the platform administrator.</p>
        </section>
        <section class="card flush">
          @if (b.invoices.length) {
            <table class="ui-table">
              <thead><tr><th>Invoice</th><th>Period</th><th>Due</th><th class="num">Amount</th><th>Status</th></tr></thead>
              <tbody>
                @for (i of b.invoices; track i.id) {
                  <tr><td class="mono small">{{ i.number }}</td><td class="small">{{ i.periodStart }} – {{ i.periodEnd }}</td><td class="small">{{ i.dueOn }}</td><td class="num">{{ i.currency }} {{ money(i.amount, i.currency) }}</td><td><ui-badge [tone]="i.status === 'PAID' ? 'ok' : i.status === 'DUE' ? 'warn' : 'neutral'">{{ i.status }}</ui-badge></td></tr>
                }
              </tbody>
            </table>
          } @else {
            <ui-empty title="No invoices yet" />
          }
        </section>
      } @else {
        <p class="muted">{{ data.errorMessage() ?? 'Loading…' }}</p>
      }
    </div>
  `,
  styles: `
    .usage { display: grid; grid-template-columns: 90px 1fr 110px; gap: var(--s3); align-items: center; }
    .label { text-transform: capitalize; }
    .bar { height: 10px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
    .fill { height: 100%; background: var(--accent); }
    .fill.full { background: var(--danger); }
    .num { text-align: right; }
  `,
})
export class BillingPage {
  private readonly http = inject(HttpClient);
  protected readonly keys = ['stores', 'devices', 'users', 'products'] as const;
  protected readonly data = apiResource({ loader: () => firstValueFrom(this.http.get<Billing>('/api/billing')) });
  protected money(n: number, c: string) {
    return formatMinor(n, c);
  }
  protected pct(used: number, max: number) {
    return Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  }
}
