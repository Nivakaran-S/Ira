import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty } from 'ui';
import { CommerceApi, type ShiftReport } from './commerce-api';
import { Money } from './money';

@Component({
  selector: 'admin-shifts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, UiBadge, UiDialog, UiEmpty],
  template: `
    <div class="page stack">
      <h1>Shifts</h1>
      <section class="card flush">
        @if (list.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Register</th><th>Opened</th><th>Closed</th><th class="num">Expected</th><th class="num">Counted</th><th class="num">Variance</th><th></th></tr></thead>
            <tbody>
              @for (s of list.value(); track s.id) {
                <tr>
                  <td>{{ s.register.code }}</td>
                  <td>{{ s.openedAt | date: 'short' }}</td>
                  <td>@if (s.closedAt) { {{ s.closedAt | date: 'short' }} } @else { <ui-badge tone="ok">Open</ui-badge> }</td>
                  <td class="num">{{ money.fmt(s.expectedCash) }}</td>
                  <td class="num">{{ money.fmt(s.countedCash) }}</td>
                  <td class="num" [class.bad]="(s.variance ?? 0) !== 0">{{ money.fmt(s.variance) }}</td>
                  <td><button class="btn small" type="button" (click)="open(s.id)">Report</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="list.errorMessage() ?? (list.isLoading() ? 'Loading…' : 'No shifts yet')" />
        }
      </section>
    </div>

    <ui-dialog [title]="report()?.shift?.status === 'CLOSED' ? 'Z report' : 'X report (shift still open)'" [open]="!!report()" (closed)="report.set(null)">
      @if (report(); as r) {
        <div class="grid-2">
          <div>Sales ({{ r.sales.count }})</div><div class="num">{{ money.fmt(r.sales.total + r.sales.rounding) }}</div>
          <div>Discounts</div><div class="num">{{ money.fmt(r.sales.discountTotal) }}</div>
          <div>Tax</div><div class="num">{{ money.fmt(r.sales.taxTotal) }}</div>
          <div>Refunds ({{ r.refunds.count }})</div><div class="num">−{{ money.fmt(r.refunds.total) }}</div>
          <div>Voids ({{ r.voids.count }})</div><div class="num">{{ money.fmt(r.voids.total) }}</div>
          @for (p of r.payments; track p.method) { <div>{{ p.method }}</div><div class="num">{{ money.fmt(p.amount) }}</div> }
          <div><strong>Expected cash</strong></div><div class="num"><strong>{{ money.fmt(r.cash.expected) }}</strong></div>
          <div>Counted</div><div class="num">{{ money.fmt(r.shift.countedCash) }}</div>
          <div>Variance</div><div class="num">{{ money.fmt(r.shift.variance) }}</div>
        </div>
        @if (r.movements.length) {
          <h3>Cash movements</h3>
          @for (m of r.movements; track $index) { <div class="small">{{ m.createdAt | date: 'shortTime' }} {{ m.type }} {{ money.fmt(m.amount) }} · {{ m.reason }}</div> }
        }
      }
    </ui-dialog>
  `,
  styles: `.num { text-align: right; } .bad { color: var(--danger); font-weight: 600; } .grid-2 { grid-template-columns: 1fr auto; gap: var(--s2) var(--s5); }`,
})
export class Shifts {
  private readonly api = inject(CommerceApi);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly list = apiResource({ loader: () => this.api.shifts() });
  protected readonly report = signal<ShiftReport | null>(null);

  protected async open(id: string) {
    try {
      this.report.set(await this.api.shift(id));
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
