import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { type PaymentMethodKey, prorate, uuidv7 } from '@pos/shared';
import { humanMessage, toApiError, ToastService } from 'ui';
import { ApprovalCancelled, Approvals } from '../api/approvals';
import { PosApi, type Sale } from '../api/pos-api';
import { HardwareBridge } from '../hardware/bridge';
import { TillState } from '../till-state';

/** Look up a receipt, pick what comes back, refund it. Amounts mirror the API's proportional split. */
@Component({
  selector: 'pos-refund',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack">
      <h1>Refund</h1>
      @if (state.offline()) {
        <p class="error-text" data-testid="refund-offline">Refunds need a connection to the server.</p>
      }
      @if (!state.shiftOpen()) {
        <p class="muted">Open a shift first: refunds are paid from this till's drawer.</p>
      }
      <form class="row" (submit)="$event.preventDefault(); find()">
        <input aria-label="Receipt number" placeholder="Receipt number, e.g. T1-000123" data-testid="receipt-no" [value]="receiptNo()" (input)="receiptNo.set(val($event))" style="max-width: 320px" />
        <button type="submit" class="btn primary" [disabled]="!receiptNo().trim()">Find</button>
      </form>
      @if (error()) {
        <div class="error-text" role="alert">{{ error() }}</div>
      }

      @if (sale(); as s) {
        <section class="card stack">
          <div class="row-between">
            <strong>{{ s.receiptNo }}</strong>
            <span class="muted">Paid {{ state.money(s.due) }}</span>
          </div>
          @if (s.status === 'VOIDED') {
            <p class="error-text">This sale was voided and cannot be refunded.</p>
          } @else {
            <table class="ui-table">
              <thead><tr><th>Item</th><th>Sold</th><th>Left</th><th>Refund qty</th><th>Amount</th></tr></thead>
              <tbody>
                @for (l of s.lines; track l.id) {
                  <tr>
                    <td>{{ l.name }}</td>
                    <td>{{ state.qty(l.qtyMilli) }}</td>
                    <td>{{ state.qty(l.qtyMilli - l.refundedQtyMilli) }}</td>
                    <td>
                      <input inputmode="decimal" style="max-width: 90px" [attr.data-refund-line]="l.name" [disabled]="l.qtyMilli === l.refundedQtyMilli"
                        [value]="qtyText(l.id)" (input)="setQty(l.id, val($event))" />
                      <button type="button" class="btn small" [disabled]="l.qtyMilli === l.refundedQtyMilli" (click)="all(l.id, l.qtyMilli - l.refundedQtyMilli)">All</button>
                    </td>
                    <td>{{ state.money(amountFor(l.id)) }}</td>
                  </tr>
                }
              </tbody>
            </table>
            <div class="row">
              <label>Refund to
                <select [value]="method()" (change)="setMethod(val($event))">
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="OTHER">Other</option>
                  @if (s.customerId) { <option value="STORE_CREDIT">Store credit</option> }
                </select>
              </label>
              <label class="grow">Reason<input data-testid="refund-reason" [value]="reason()" (input)="reason.set(val($event))" /></label>
              <label class="check"><input type="checkbox" [checked]="restock()" (change)="restock.set(checked($event))" /> Back to stock</label>
            </div>
            <div class="row-between">
              <strong>Refund {{ state.money(total()) }}</strong>
              <button type="button" class="btn primary" data-testid="do-refund" [disabled]="!valid() || busy() || !state.shiftOpen() || state.offline()" (click)="submit(s)">Refund</button>
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: `
    label { display: flex; flex-direction: column; gap: 4px; font-weight: 550; }
    .grow { flex: 1; min-width: 200px; }
    .check { flex-direction: row; align-items: center; }
  `,
})
export class Refund {
  protected readonly state = inject(TillState);
  private readonly api = inject(PosApi);
  private readonly approvals = inject(Approvals);
  private readonly bridge = inject(HardwareBridge);
  private readonly toasts = inject(ToastService);

  protected readonly receiptNo = signal('');
  protected readonly sale = signal<Sale | null>(null);
  protected readonly qty = signal<Record<string, number>>({});
  protected readonly method = signal<PaymentMethodKey>('CASH');
  protected readonly reason = signal('');
  protected readonly restock = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly total = computed(() => Object.keys(this.qty()).reduce((s, id) => s + this.amountFor(id), 0));
  protected readonly valid = computed(() => this.total() > 0 && this.reason().trim().length >= 3);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected setMethod(v: string) {
    this.method.set(v as PaymentMethodKey);
  }
  protected checked(e: Event) {
    return (e.target as HTMLInputElement).checked;
  }

  protected async find() {
    this.error.set(null);
    this.sale.set(null);
    this.qty.set({});
    try {
      const s = await this.api.lookup(this.receiptNo().trim().toUpperCase());
      this.sale.set(s);
      const first = s.payments[0]?.method ?? 'CASH';
      this.method.set(first === 'LOYALTY' ? 'CASH' : first);
    } catch (e) {
      this.error.set(humanMessage(toApiError(e)));
    }
  }

  protected qtyText(id: string) {
    const q = this.qty()[id];
    return q ? this.state.qty(q) : '';
  }

  protected setQty(id: string, text: string) {
    const line = this.sale()?.lines.find((l) => l.id === id);
    const n = Math.round(Number(text) * 1000);
    this.qty.update((m) => {
      const next = { ...m };
      if (!line || !Number.isFinite(n) || n <= 0) delete next[id];
      else next[id] = Math.min(n, line.qtyMilli - line.refundedQtyMilli);
      return next;
    });
  }

  protected all(id: string, left: number) {
    this.qty.update((m) => ({ ...m, [id]: left }));
  }

  /** Same split as the API: the share for (already refunded + this) minus the share already refunded. */
  protected amountFor(id: string) {
    const l = this.sale()?.lines.find((x) => x.id === id);
    const q = this.qty()[id];
    if (!l || !q) return 0;
    return prorate(l.total, l.refundedQtyMilli + q, l.qtyMilli) - prorate(l.total, l.refundedQtyMilli, l.qtyMilli);
  }

  protected async submit(s: Sale) {
    this.busy.set(true);
    const body = {
      id: uuidv7(),
      saleId: s.id,
      lines: Object.entries(this.qty()).map(([saleLineId, qtyMilli]) => ({ saleLineId, qtyMilli })),
      method: this.method(),
      reason: this.reason().trim(),
      restock: this.restock(),
    };
    try {
      const refund = await this.approvals.run((h) => this.api.refund(body, h));
      this.toasts.success(`Refunded ${this.state.money(refund.total + refund.rounding)} (${refund.receiptNo})`);
      const receipt = await this.api.refundReceipt(refund.id).catch(() => null);
      if (receipt) await this.bridge.print(receipt, this.method() === 'CASH');
      this.sale.set(await this.api.sale(s.id));
      this.qty.set({});
      this.reason.set('');
      void this.state.refreshShift();
    } catch (e) {
      if (!(e instanceof ApprovalCancelled)) this.toasts.error(humanMessage(toApiError(e)));
    } finally {
      this.busy.set(false);
    }
  }
}
