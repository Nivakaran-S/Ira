import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { ReceiptDoc } from '@pos/shared';
import { apiResource, humanMessage, toApiError, ToastService, UiDialog } from 'ui';
import { ApprovalCancelled, Approvals } from '../api/approvals';
import { PosApi, type Sale, type SaleSummary } from '../api/pos-api';
import { HardwareBridge, TerminalError } from '../hardware/bridge';
import { OfflineRefused, OfflineTill } from '../offline/offline-till';
import { SaleJournal } from '../offline/sale-journal';
import { isOfflineError } from '../offline/sync-engine';
import { TillState } from '../till-state';
import { ReceiptView } from './receipt-view';

@Component({
  selector: 'pos-sales-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, UiDialog, ReceiptView],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Recent sales on this till</h1>
        <button type="button" class="btn" (click)="recent.reload()">Refresh</button>
      </div>
      <section class="card flush">
        <table class="ui-table">
          <thead><tr><th>Receipt</th><th>Time</th><th>Total</th><th>Status</th><th></th></tr></thead>
          <tbody>
            @for (s of recent.value() ?? []; track s.id) {
              <tr [attr.data-receipt]="s.receiptNo">
                <td class="mono">{{ s.receiptNo }}</td>
                <td>{{ s.soldAt | date: 'shortTime' }}</td>
                <td>{{ state.money(s.due) }}</td>
                <td>{{ s.status === 'VOIDED' ? 'Voided' : 'Completed' }}@if (s.offline) { <span class="muted small"> · offline</span> }</td>
                <td><button type="button" class="btn small" (click)="open(s.id)">Open</button></td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="muted">{{ recent.errorMessage() ?? (recent.isLoading() ? 'Loading…' : 'No sales yet.') }}</td></tr>
            }
          </tbody>
        </table>
      </section>
    </div>

    <ui-dialog [title]="'Sale ' + (selected()?.sale?.receiptNo ?? '')" [open]="!!selected()" (closed)="selected.set(null)">
      @if (selected(); as s) {
        <div class="stack">
          @if (s.receipt) {
            <pos-receipt-view [receipt]="s.receipt" />
          }
          @if (voiding()) {
            <label>Why is this sale being voided?<input data-testid="void-reason" [value]="reason()" (input)="reason.set(val($event))" /></label>
          }
          <div class="row-between">
            <button type="button" class="btn" [disabled]="!s.receipt" (click)="reprint(s.sale)">Reprint</button>
            @if (s.sale.status === 'COMPLETED' && !s.sale.refunds.length && s.sale.shiftId === state.shift()?.shift?.id) {
              @if (voiding()) {
                <button type="button" class="btn danger" data-testid="confirm-void" [disabled]="reason().trim().length < 3 || busy()" (click)="voidSale(s.sale)">Void sale</button>
              } @else {
                <button type="button" class="btn" data-testid="void" (click)="voiding.set(true)">Void…</button>
              }
            }
          </div>
        </div>
      }
    </ui-dialog>
  `,
  styles: `label { display: flex; flex-direction: column; gap: 4px; font-weight: 550; } .btn.danger { background: var(--danger); color: #fff; border-color: var(--danger); }`,
})
export class SalesHistory {
  protected readonly state = inject(TillState);
  private readonly api = inject(PosApi);
  private readonly approvals = inject(Approvals);
  private readonly bridge = inject(HardwareBridge);
  private readonly toasts = inject(ToastService);
  private readonly offlineTill = inject(OfflineTill);
  private readonly journal = inject(SaleJournal);

  /** The server's list online; this till's journal when the server cannot be reached. */
  protected readonly recent = apiResource({
    loader: async (): Promise<(SaleSummary & { offline?: boolean })[]> => {
      if (!this.state.offline()) {
        try {
          return await this.api.recent();
        } catch (e) {
          if (!isOfflineError(e)) throw e;
        }
      }
      return this.journal.recent();
    },
  });
  protected readonly selected = signal<{ sale: Sale; receipt: ReceiptDoc | null } | null>(null);
  protected readonly voiding = signal(false);
  protected readonly reason = signal('');
  protected readonly busy = signal(false);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async open(id: string) {
    this.voiding.set(false);
    this.reason.set('');
    try {
      if (this.state.offline()) throw Object.assign(new Error('offline'), { status: 0 });
      const [sale, receipt] = await Promise.all([this.api.sale(id), this.api.receipt(id, true).catch(() => null)]);
      await this.journal.put(sale);
      this.selected.set({ sale, receipt });
    } catch (e) {
      const local = isOfflineError(e) || this.state.offline() ? await this.journal.byId(id) : undefined;
      if (local) this.selected.set({ sale: local, receipt: null });
      else this.toasts.error(humanMessage(toApiError(e)));
    }
  }

  protected async reprint(sale: Sale) {
    const receipt = await this.api.receipt(sale.id, true);
    await this.bridge.print(receipt);
  }

  /** Card payments charged on the terminal are given back on it once the sale is voided. */
  private async reverseCards(sale: Sale) {
    const charged = sale.payments.filter((p) => p.method === 'CARD' && p.card);
    for (const [i, p] of charged.entries()) {
      const r = await this.bridge.terminal('refund', p.amount, this.state.currency(), `void-${sale.id}-${i}`, p.card!.terminalRef);
      if (r.status !== 'APPROVED') throw new TerminalError(`The terminal did not reverse the card payment: ${r.message ?? r.status.toLowerCase()}.`);
    }
  }

  protected async voidSale(sale: Sale) {
    this.busy.set(true);
    const reason = this.reason().trim();
    try {
      if (this.state.offline()) await this.offlineTill.voidSale(sale, reason);
      else {
        try {
          await this.approvals.run((h) => this.api.void(sale.id, reason, h));
          await this.journal.update(sale.receiptNo, (s) => ({ ...s, status: 'VOIDED' }));
        } catch (e) {
          if (!isOfflineError(e)) throw e;
          this.state.sync.online.set(false);
          await this.offlineTill.voidSale(sale, reason);
        }
      }
      this.toasts.success(`Sale ${sale.receiptNo} voided`);
      try {
        await this.reverseCards(sale);
      } catch (e) {
        this.toasts.error(`${(e as Error).message} Refund the card on the terminal by hand.`);
      }
      this.selected.set(null);
      this.recent.reload();
      void this.state.refreshShift();
    } catch (e) {
      if (e instanceof OfflineRefused || e instanceof TerminalError) this.toasts.error(e.message);
      else if (!(e instanceof ApprovalCancelled)) this.toasts.error(humanMessage(toApiError(e)));
    } finally {
      this.busy.set(false);
    }
  }
}
