import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { formatMinor } from '@pos/shared';
import { firstValueFrom } from 'rxjs';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiEmpty } from 'ui';
import { BackofficeSession } from './session';

interface Billing {
  onlinePayment: boolean;
  suspendedForBilling: boolean;
  plan: { key: string; name: string; priceMonthly: number; currency: string };
  limits: Record<'stores' | 'devices' | 'users' | 'products', number>;
  usage: Record<'stores' | 'devices' | 'users' | 'products', number>;
  invoices: {
    id: string; number: string; periodStart: string; periodEnd: string; dueOn: string; amount: number; currency: string; status: string; paidRef: string | null;
    lastPayment: { status: 'PENDING' | 'SUCCEEDED' | 'FAILED'; failureReason: string | null } | null;
  }[];
}

/** The business's plan, how much of it is used, and its invoices, which the owner can pay online. */
@Component({
  selector: 'admin-billing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiEmpty],
  template: `
    <div class="page stack">
      <h1>Plan and billing</h1>
      @if (returned() === 'success') {
        <div class="notice" role="status" data-testid="payment-success">Payment received. Thank you.</div>
      } @else if (returned() === 'submitted') {
        <div class="notice" role="status" data-testid="payment-submitted">Payment submitted. The invoice shows as paid as soon as the payment provider confirms it, usually within a minute.</div>
      } @else if (returned() === 'failed' || returned() === 'cancelled') {
        <div class="notice danger" role="alert" data-testid="payment-failed">The payment did not go through. Nothing was charged; you can try again.</div>
      }
      @if (data.value(); as b) {
        @if (b.suspendedForBilling) {
          <div class="notice danger" role="alert" data-testid="suspended-billing">This business is suspended for an unpaid invoice. Pay it below to reopen it straight away.</div>
        }
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
              <thead><tr><th>Invoice</th><th>Period</th><th>Due</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
              <tbody>
                @for (i of b.invoices; track i.id) {
                  <tr [attr.data-invoice]="i.number">
                    <td class="mono small">{{ i.number }}</td><td class="small">{{ i.periodStart }} – {{ i.periodEnd }}</td><td class="small">{{ i.dueOn }}</td>
                    <td class="num">{{ i.currency }} {{ money(i.amount, i.currency) }}</td>
                    <td>
                      <ui-badge [tone]="i.status === 'PAID' ? 'ok' : i.status === 'DUE' ? 'warn' : 'neutral'">{{ i.status }}</ui-badge>
                      @if (i.status === 'DUE' && i.lastPayment?.status === 'FAILED') { <span class="small muted"> · last attempt failed</span> }
                    </td>
                    <td>
                      @if (i.status === 'DUE' && b.onlinePayment && session.can('billing.pay')) {
                        <button type="button" class="btn small primary" data-testid="pay-invoice" [disabled]="paying()" (click)="pay(i.id)">Pay now</button>
                      }
                    </td>
                  </tr>
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
  private readonly toasts = inject(ToastService);
  protected readonly session = inject(BackofficeSession);
  protected readonly returned = signal(inject(ActivatedRoute).snapshot.queryParamMap.get('payment'));
  protected readonly paying = signal(false);
  protected readonly keys = ['stores', 'devices', 'users', 'products'] as const;
  protected readonly data = apiResource({ loader: () => firstValueFrom(this.http.get<Billing>('/api/billing')) });
  /** Off to the gateway's hosted checkout; it sends the browser back here with ?payment=… */
  protected async pay(invoiceId: string) {
    this.paying.set(true);
    try {
      const { url, fields } = await firstValueFrom(this.http.post<{ url: string; fields?: Record<string, string> }>(`/api/billing/invoices/${invoiceId}/checkout`, {}));
      if (!fields) return window.location.assign(url);
      // Providers like PayHere take a signed form post to their checkout page.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = url;
      for (const [name, value] of Object.entries(fields)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
      this.paying.set(false);
    }
  }

  protected money(n: number, c: string) {
    return formatMinor(n, c);
  }
  protected pct(used: number, max: number) {
    return Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  }
}
