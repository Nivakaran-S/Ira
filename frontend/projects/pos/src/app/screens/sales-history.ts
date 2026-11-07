import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { ReceiptDoc } from '@pos/shared';
import { apiResource, humanMessage, toApiError, ToastService, UiDialog } from 'ui';
import { ApprovalCancelled, Approvals } from '../api/approvals';
import { PosApi, type Sale } from '../api/pos-api';
import { HardwareBridge } from '../hardware/bridge';
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
                <td>{{ s.status === 'VOIDED' ? 'Voided' : 'Completed' }}</td>
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
            <button type="button" class="btn" (click)="reprint(s.sale)">Reprint</button>
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

  protected readonly recent = apiResource({ loader: () => this.api.recent() });
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
      const [sale, receipt] = await Promise.all([this.api.sale(id), this.api.receipt(id, true).catch(() => null)]);
      this.selected.set({ sale, receipt });
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }

  protected async reprint(sale: Sale) {
    const receipt = await this.api.receipt(sale.id, true);
    await this.bridge.print(receipt);
  }

  protected async voidSale(sale: Sale) {
    this.busy.set(true);
    try {
      const voided = await this.approvals.run((h) => this.api.void(sale.id, this.reason().trim(), h));
      this.toasts.success(`Sale ${voided.receiptNo} voided`);
      this.selected.set(null);
      this.recent.reload();
      void this.state.refreshShift();
    } catch (e) {
      if (!(e instanceof ApprovalCancelled)) this.toasts.error(humanMessage(toApiError(e)));
    } finally {
      this.busy.set(false);
    }
  }
}
