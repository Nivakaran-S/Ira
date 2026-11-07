import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { type CardResult, type PaymentMethodKey, prorate, uuidv7 } from '@pos/shared';
import { humanMessage, toApiError, ToastService } from 'ui';
import { ApprovalCancelled, Approvals } from '../api/approvals';
import { PosApi, type Sale } from '../api/pos-api';
import { cardOf, HardwareBridge, TerminalError } from '../hardware/bridge';
import { OfflineRefused, OfflineTill } from '../offline/offline-till';
import { SaleJournal } from '../offline/sale-journal';
import { isOfflineError } from '../offline/sync-engine';
import { TillState } from '../till-state';

/**
 * Look up a receipt, pick what comes back, refund it. Amounts mirror the API's proportional split.
 * Offline, the sale comes from this till's journal and the refund goes into the outbox.
 */
@Component({
  selector: 'pos-refund',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack">
      <h1>Refund</h1>
      @if (state.offline()) {
        <p class="small muted" data-testid="refund-offline">Offline: sales made or looked up on this till in the last week can be refunded, up to the business's offline limit.</p>
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
              <button type="button" class="btn primary" data-testid="do-refund" [disabled]="!valid() || busy() || !state.shiftOpen()" (click)="submit(s)">
                {{ method() === 'CARD' && bridge.hasTerminal() ? 'Refund to card' : 'Refund' }}
              </button>
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
  protected readonly bridge = inject(HardwareBridge);
  private readonly toasts = inject(ToastService);
  private readonly offlineTill = inject(OfflineTill);
  private readonly journal = inject(SaleJournal);
  /** One id per refund attempt: retries reuse it, so neither the API nor the terminal refunds twice. */
  private attempt: { id: string; card?: CardResult; online?: string[]; offline?: { action: string; approverId: string }[] } = { id: uuidv7() };

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
    const no = this.receiptNo().trim().toUpperCase();
    this.attempt = { id: uuidv7() };
    try {
      let s = this.state.offline() ? await this.journal.get(no) : null;
      if (!s) {
        try {
          s = await this.api.lookup(no);
          await this.journal.put(s);
        } catch (e) {
          if (!isOfflineError(e)) throw e;
          s = await this.journal.get(no);
          if (!s) throw new OfflineRefused('Offline, only sales made or looked up on this till in the last week can be found.');
        }
      }
      this.sale.set(s);
      const first = s.payments[0]?.method ?? 'CASH';
      this.method.set(first === 'LOYALTY' ? 'CASH' : first);
    } catch (e) {
      this.error.set(e instanceof OfflineRefused ? e.message : humanMessage(toApiError(e)));
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

  /** Card refunds go back through the terminal first, against the original charge when known. */
  private async terminalRefund(s: Sale): Promise<CardResult | undefined> {
    if (this.method() !== 'CARD' || !this.bridge.hasTerminal()) return undefined;
    if (this.attempt.card) return this.attempt.card;
    const original = s.payments.find((p) => p.method === 'CARD' && p.card)?.card?.terminalRef;
    const r = await this.bridge.terminal('refund', this.total(), this.state.currency(), this.attempt.id, original);
    if (r.status !== 'APPROVED') throw new TerminalError(`The terminal did not refund the card: ${r.message ?? r.status.toLowerCase()}.`);
    this.attempt = { ...this.attempt, card: cardOf(r) };
    return this.attempt.card;
  }

  protected async submit(s: Sale) {
    this.busy.set(true);
    const lines = Object.entries(this.qty()).map(([saleLineId, qtyMilli]) => ({ saleLineId, qtyMilli }));
    const method = this.method() as 'CASH' | 'CARD' | 'OTHER' | 'STORE_CREDIT';
    try {
      // The manager approves before the terminal pays anything back.
      if (method === 'CARD' && this.bridge.hasTerminal() && !this.attempt.card && this.offlineTill.refundNeedsApproval(this.total())) {
        if (this.state.offline()) this.attempt.offline ??= await this.approvals.collectOffline(['sale.refund']);
        else this.attempt.online ??= [await this.approvals.ask('sale.refund')];
      }
      const card = await this.terminalRefund(s);
      const body = { id: this.attempt.id, saleId: s.id, lines, method, reason: this.reason().trim(), restock: this.restock(), ...(card ? { card } : {}) };
      if (this.state.offline()) await this.offline(s, body);
      else {
        try {
          const refund = await this.approvals.run((h) => this.api.refund(body, h), this.attempt.online);
          this.toasts.success(`Refunded ${this.state.money(refund.total + refund.rounding)} (${refund.receiptNo})`);
          const receipt = await this.api.refundReceipt(refund.id).catch(() => null);
          if (receipt) await this.bridge.print(receipt, method === 'CASH');
          const fresh = await this.api.sale(s.id);
          await this.journal.put(fresh);
          this.sale.set(fresh);
          void this.state.refreshShift();
        } catch (e) {
          if (!isOfflineError(e)) throw e;
          this.state.sync.online.set(false);
          await this.offline(s, body);
        }
      }
      this.attempt = { id: uuidv7() };
      this.qty.set({});
      this.reason.set('');
    } catch (e) {
      if (e instanceof OfflineRefused || e instanceof TerminalError) this.toasts.error(e.message);
      else if (!(e instanceof ApprovalCancelled)) this.toasts.error(humanMessage(toApiError(e)));
    } finally {
      this.busy.set(false);
    }
  }

  private async offline(s: Sale, b: { id: string; lines: { saleLineId: string; qtyMilli: number }[]; method: 'CASH' | 'CARD' | 'OTHER' | 'STORE_CREDIT'; reason: string; restock: boolean; card?: CardResult }) {
    const r = await this.offlineTill.refund(s, b.lines, b.method, b.reason, b.restock, b.id, b.card, this.attempt.offline);
    this.toasts.success(`Refunded ${this.state.money(r.paidOut)} (${r.receiptNo}), offline`);
    await this.bridge.print(r.receipt, b.method === 'CASH');
    this.sale.set((await this.journal.get(s.receiptNo)) ?? s);
  }
}
