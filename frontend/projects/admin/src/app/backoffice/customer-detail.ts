import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { apiResource, humanMessage, toApiError, ToastService } from 'ui';
import { Money } from './money';
import { RetailApi } from './retail-api';
import { BackofficeSession } from './session';

@Component({
  selector: 'admin-customer-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink],
  template: `
    <div class="page stack">
      <a routerLink="/customers">← Customers</a>
      @if (data.value(); as d) {
        <div class="row-between">
          <h1>{{ d.customer.name }}</h1>
          <span class="muted">{{ d.customer.phone ?? '' }} {{ d.customer.email ?? '' }}</span>
        </div>
        <section class="grid-2">
          @if (loyaltyOn()) {
            <div class="card stack">
              <div class="muted small">Loyalty points</div>
              <div class="stat" data-testid="points">{{ d.points }}</div>
              <div class="row">
                <input aria-label="Points change" placeholder="+/- points" [value]="pts()" (input)="pts.set(val($event))" style="max-width: 120px" />
                <input aria-label="Points reason" placeholder="Reason" [value]="ptsReason()" (input)="ptsReason.set(val($event))" style="flex: 1" />
                <button class="btn small" type="button" (click)="adjust('loyalty')">Adjust</button>
              </div>
            </div>
          }
          <div class="card stack">
            <div class="muted small">Store credit</div>
            <div class="stat" data-testid="credit">{{ money.fmt(d.credit) }}</div>
            <div class="row">
              <input aria-label="Credit change" placeholder="+/- amount" [value]="amt()" (input)="amt.set(val($event))" style="max-width: 120px" />
              <input aria-label="Credit reason" placeholder="Reason" [value]="amtReason()" (input)="amtReason.set(val($event))" style="flex: 1" />
              <button class="btn small" type="button" (click)="adjust('credit')">Adjust</button>
            </div>
          </div>
        </section>
        <section class="card flush">
          <table class="ui-table">
            <thead><tr><th>Receipt</th><th>When</th><th class="num">Total</th><th>Points</th><th>Status</th></tr></thead>
            <tbody>
              @for (s of d.sales; track s.id) {
                <tr><td class="mono">{{ s.receiptNo }}</td><td>{{ s.soldAt | date: 'short' }}</td><td class="num">{{ money.fmt(s.due) }}</td><td>{{ s.loyaltyEarned }}</td><td>{{ s.status }}</td></tr>
              } @empty { <tr><td colspan="5" class="muted">No purchases yet.</td></tr> }
            </tbody>
          </table>
        </section>
        <div class="grid-2">
          <section class="card stack">
            <h2>Points history</h2>
            @for (l of d.loyaltyLedger; track l.id) { <div class="row-between small"><span>{{ l.createdAt | date: 'short' }} {{ l.reason }} {{ l.note ?? '' }}</span><span>{{ l.delta > 0 ? '+' : '' }}{{ l.delta }}</span></div> }
          </section>
          <section class="card stack">
            <h2>Credit history</h2>
            @for (l of d.creditLedger; track l.id) { <div class="row-between small"><span>{{ l.createdAt | date: 'short' }} {{ l.reason }} {{ l.note ?? '' }}</span><span>{{ money.fmt(l.delta) }}</span></div> }
          </section>
        </div>
      } @else {
        <p class="muted">{{ data.errorMessage() ?? 'Loading…' }}</p>
      }
    </div>
  `,
  styles: `.stat { font-size: 26px; font-weight: 700; } .num { text-align: right; }`,
})
export class CustomerDetail {
  private readonly api = inject(RetailApi);
  private readonly toasts = inject(ToastService);
  private readonly session = inject(BackofficeSession);
  protected readonly money = inject(Money);
  readonly id = input.required<string>();
  protected readonly data = apiResource({ params: () => this.id(), loader: ({ params }) => this.api.customer(params) });
  protected readonly loyaltyOn = computed(() => this.session.modules().includes('loyalty'));
  protected readonly pts = signal('');
  protected readonly ptsReason = signal('');
  protected readonly amt = signal('');
  protected readonly amtReason = signal('');

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async adjust(kind: 'loyalty' | 'credit') {
    const text = kind === 'loyalty' ? this.pts() : this.amt();
    const reason = (kind === 'loyalty' ? this.ptsReason() : this.amtReason()).trim();
    const neg = text.trim().startsWith('-');
    const abs = kind === 'loyalty' ? Number(text.replace(/^[-+]/, '')) : this.money.parse(text.replace(/^[-+]/, ''));
    if (!abs || !Number.isInteger(abs) || reason.length < 3) return this.toasts.error('Enter a whole change and a reason.');
    try {
      await this.api.adjust(this.id(), kind, neg ? -abs : abs, reason);
      this.toasts.success('Balance adjusted');
      this.pts.set('');
      this.amt.set('');
      this.data.reload();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
