import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { apiResource, UiEmpty } from 'ui';
import { CommerceApi } from './commerce-api';
import { Money } from './money';

type Preset = 'today' | '7d' | '30d' | 'month';

function range(p: Preset): { from: Date; to: Date } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today.getTime() + 86_400_000);
  switch (p) {
    case 'today':
      return { from: today, to: tomorrow };
    case '7d':
      return { from: new Date(today.getTime() - 6 * 86_400_000), to: tomorrow };
    case '30d':
      return { from: new Date(today.getTime() - 29 * 86_400_000), to: tomorrow };
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: tomorrow };
  }
}

@Component({
  selector: 'admin-reports',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiEmpty],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Reports</h1>
        <div class="row">
          @for (p of presets; track p.key) {
            <button type="button" class="btn small" [class.primary]="preset() === p.key" (click)="preset.set(p.key)">{{ p.label }}</button>
          }
        </div>
      </div>
      @if (data.value(); as d) {
        <section class="kpis">
          <div class="card"><div class="muted small">Net sales</div><div class="kpi" data-testid="net-sales">{{ money.fmt(d.net) }}</div></div>
          <div class="card"><div class="muted small">Sales</div><div class="kpi">{{ d.sales.count }}</div></div>
          <div class="card"><div class="muted small">Average sale</div><div class="kpi">{{ money.fmt(d.sales.count ? Math.round(d.sales.total / d.sales.count) : 0) }}</div></div>
          <div class="card"><div class="muted small">Refunds</div><div class="kpi">{{ money.fmt(d.refunds.total) }}</div></div>
          @if (d.sales.tips) { <div class="card"><div class="muted small">Tips (not revenue)</div><div class="kpi">{{ money.fmt(d.sales.tips) }}</div></div> }
        </section>

        <section class="card stack">
          <h2>By day</h2>
          @if (d.byDay.length) {
            <div class="bars" role="img" [attr.aria-label]="'Daily sales, highest ' + money.fmt(maxDay())">
              @for (day of d.byDay; track day.day) {
                <div class="bar-col" [title]="day.day + ': ' + money.fmt(day.total)">
                  <div class="bar" [style.height.%]="(day.total / maxDay()) * 100"></div>
                  <div class="small muted">{{ day.day.slice(5) }}</div>
                </div>
              }
            </div>
          } @else {
            <ui-empty title="No sales in this period" />
          }
        </section>

        <div class="grid-2">
          <section class="card stack">
            <h2>Top products</h2>
            @for (p of d.topProducts; track p.productId) {
              <div class="row-between"><span>{{ p.name }} <span class="muted small">× {{ money.qty(p.qtyMilli) }}</span></span><span>{{ money.fmt(p.total) }}</span></div>
            } @empty { <p class="muted">Nothing sold yet.</p> }
          </section>
          <section class="card stack">
            <h2>Payments</h2>
            @for (p of d.payments; track p.method) {
              <div class="row-between"><span>{{ p.method }}</span><span>{{ money.fmt(p.amount) }}</span></div>
            } @empty { <p class="muted">No payments.</p> }
            <h2>Tax collected</h2>
            @for (t of d.taxes; track t.name + t.rateBp) {
              <div class="row-between"><span>{{ t.name }} {{ money.pct(t.rateBp) }} <span class="muted small">on {{ money.fmt(t.taxable) }}</span></span><span>{{ money.fmt(t.amount) }}</span></div>
            } @empty { <p class="muted">No tax.</p> }
            <p class="small muted">Discounts given {{ money.fmt(d.sales.discountTotal) }} · Voids {{ d.voids.count }} ({{ money.fmt(d.voids.total) }}) · Times in {{ d.range.timezone }}</p>
          </section>
        </div>
      } @else {
        <ui-empty [title]="data.errorMessage() ?? 'Loading…'" />
      }
    </div>
  `,
  styles: `
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--s4); }
    .kpi { font-size: 26px; font-weight: 700; }
    .bars { display: flex; align-items: flex-end; gap: var(--s2); height: 180px; }
    .bar-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; min-width: 18px; }
    .bar { width: 100%; max-width: 40px; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 2px; }
  `,
})
export class Reports {
  private readonly api = inject(CommerceApi);
  protected readonly money = inject(Money);
  protected readonly Math = Math;
  protected readonly presets: { key: Preset; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: '7d', label: '7 days' },
    { key: '30d', label: '30 days' },
    { key: 'month', label: 'This month' },
  ];
  protected readonly preset = signal<Preset>('7d');
  protected readonly data = apiResource({
    params: () => this.preset(),
    loader: ({ params }) => {
      const r = range(params);
      return this.api.summary(r.from.toISOString(), r.to.toISOString());
    },
  });
  protected readonly maxDay = computed(() => Math.max(1, ...(this.data.value()?.byDay.map((d) => d.total) ?? [1])));
}
