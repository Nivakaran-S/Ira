import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty } from 'ui';
import { CommerceApi, type SaleDetail } from './commerce-api';
import { Money } from './money';

const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const METHOD: Record<string, string> = { CASH: 'Cash', CARD: 'Card', OTHER: 'Other' };

@Component({
  selector: 'admin-sales',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, UiBadge, UiDialog, UiEmpty],
  template: `
    <div class="page stack">
      <h1>Sales</h1>
      <form class="row" (submit)="$event.preventDefault(); list.reload()">
        <label>From<input type="date" [value]="from()" (change)="from.set(val($event))" /></label>
        <label>To<input type="date" [value]="to()" (change)="to.set(val($event))" /></label>
        <label>Receipt<input [value]="receiptNo()" (input)="receiptNo.set(val($event))" placeholder="T1-000123" /></label>
        <button class="btn" type="submit">Search</button>
      </form>
      <section class="card flush">
        @if (list.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Receipt</th><th>When</th><th class="num">Total</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (s of list.value(); track s.id) {
                <tr>
                  <td class="mono">{{ s.receiptNo }}</td>
                  <td>{{ s.soldAt | date: 'medium' }}</td>
                  <td class="num">{{ money.fmt(s.due) }}</td>
                  <td><ui-badge [tone]="s.status === 'VOIDED' ? 'danger' : 'ok'">{{ s.status === 'VOIDED' ? 'Voided' : 'Completed' }}</ui-badge></td>
                  <td><button class="btn small" type="button" (click)="open(s.id)">Details</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="list.errorMessage() ?? (list.isLoading() ? 'Loading…' : 'No sales in this range')" />
        }
      </section>
    </div>

    <ui-dialog [title]="'Sale ' + (detail()?.receiptNo ?? '')" [open]="!!detail()" (closed)="detail.set(null)">
      @if (detail(); as d) {
        <div class="stack">
          <table class="ui-table">
            <thead><tr><th>Item</th><th>Qty</th><th class="num">Amount</th></tr></thead>
            <tbody>
              @for (l of d.lines; track l.id) {
                <tr>
                  <td>{{ l.name }} @if (l.unitPrice !== l.listPrice) { <span class="small muted">(price {{ money.fmt(l.unitPrice) }}, list {{ money.fmt(l.listPrice) }})</span> }</td>
                  <td>{{ money.qty(l.qtyMilli) }} @if (l.refundedQtyMilli) { <span class="small muted">({{ money.qty(l.refundedQtyMilli) }} refunded)</span> }</td>
                  <td class="num">{{ money.fmt(l.net) }}</td>
                </tr>
              }
            </tbody>
          </table>
          <div class="grid-2 small">
            <div>Subtotal {{ money.fmt(d.subtotal) }} · Discounts {{ money.fmt(d.discountTotal) }} · Tax {{ money.fmt(d.taxTotal) }}</div>
            <div><strong>Total {{ money.fmt(d.due) }}</strong> @if (d.rounding) { <span class="muted">(rounding {{ money.fmt(d.rounding) }})</span> }</div>
          </div>
          <div class="small">Paid: @for (p of d.payments; track p.id) { {{ method[p.method] }} {{ money.fmt(p.amount) }}{{ p.reference ? ' (' + p.reference + ')' : '' }}; }</div>
          @if (d.approvals.length) { <div class="small">Manager approvals: @for (a of d.approvals; track a.action) { {{ a.action }}; }</div> }
          @if (d.refunds.length) {
            <div class="small">Refunds: @for (r of d.refunds; track r.id) { {{ r.receiptNo }} {{ money.fmt(r.total + r.rounding) }} ({{ method[r.method] }}); }</div>
          }
          @if (d.voidReason) { <div class="error-text">Voided: {{ d.voidReason }}</div> }
        </div>
      }
    </ui-dialog>
  `,
  styles: `.num { text-align: right; } label { display: flex; flex-direction: column; gap: 4px; font-weight: 550; }`,
})
export class Sales {
  private readonly api = inject(CommerceApi);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly method = METHOD;

  protected readonly from = signal(startOfDay(new Date(Date.now() - 6 * 86_400_000)).toISOString().slice(0, 10));
  protected readonly to = signal(new Date().toISOString().slice(0, 10));
  protected readonly receiptNo = signal('');
  protected readonly list = apiResource({
    loader: () => {
      const from = new Date(`${this.from()}T00:00:00`);
      const to = new Date(`${this.to()}T00:00:00`);
      to.setDate(to.getDate() + 1);
      return this.api.sales({ from: from.toISOString(), to: to.toISOString(), receiptNo: this.receiptNo().trim() || undefined });
    },
  });
  protected readonly detail = signal<SaleDetail | null>(null);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async open(id: string) {
    try {
      this.detail.set(await this.api.sale(id));
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
