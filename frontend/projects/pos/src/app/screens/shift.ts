import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { formatMinor, type ReceiptDoc } from '@pos/shared';
import { humanMessage, toApiError, ToastService } from 'ui';
import { ApprovalCancelled, Approvals } from '../api/approvals';
import { PosApi, type ShiftReport } from '../api/pos-api';
import { HardwareBridge } from '../hardware/bridge';
import { TillState } from '../till-state';

const METHOD: Record<string, string> = { CASH: 'Cash', CARD: 'Card', OTHER: 'Other' };

/** The Z report as a printable receipt. */
export function zReport(r: ShiftReport, currency: string, register: string): ReceiptDoc {
  const m = (n: number) => formatMinor(n, currency);
  return {
    currency,
    header: [register],
    title: r.shift.status === 'CLOSED' ? 'Z REPORT' : 'X REPORT',
    meta: [
      { label: 'Opened', value: new Date(r.shift.openedAt).toLocaleString() },
      ...(r.shift.closedAt ? [{ label: 'Closed', value: new Date(r.shift.closedAt).toLocaleString() }] : []),
    ],
    lines: [],
    totals: [
      { label: `Sales (${r.sales.count})`, value: m(r.sales.total + r.sales.rounding) },
      { label: 'Discounts', value: m(r.sales.discountTotal) },
      { label: 'Tax', value: m(r.sales.taxTotal) },
      { label: `Refunds (${r.refunds.count})`, value: `-${m(r.refunds.total)}` },
      { label: `Voids (${r.voids.count})`, value: m(r.voids.total) },
    ],
    taxes: r.payments.map((p) => ({ label: METHOD[p.method] ?? p.method, value: m(p.amount) })),
    payments: [
      { label: 'Opening float', value: m(r.cash.openingFloat) },
      { label: 'Cash sales', value: m(r.cash.sales) },
      { label: 'Cash refunds', value: `-${m(r.cash.refunds)}` },
      { label: 'Pay in', value: m(r.cash.payIns) },
      { label: 'Pay out', value: `-${m(r.cash.payOuts)}` },
      { label: 'Expected cash', value: m(r.cash.expected) },
      ...(r.shift.countedCash !== null ? [{ label: 'Counted', value: m(r.shift.countedCash) }, { label: 'Variance', value: m(r.shift.variance ?? 0) }] : []),
    ],
    footer: [],
  };
}

@Component({
  selector: 'pos-shift',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <div class="page stack">
      @if (closed(); as z) {
        <section class="card stack" data-testid="z-report">
          <h1>Shift closed</h1>
          <div class="grid-2">
            <div><div class="muted small">Expected cash</div><strong>{{ state.money(z.cash.expected) }}</strong></div>
            <div><div class="muted small">Counted</div><strong>{{ state.money(z.shift.countedCash ?? 0) }}</strong></div>
            <div><div class="muted small">Variance</div><strong data-testid="variance" [class.bad]="(z.shift.variance ?? 0) !== 0">{{ state.money(z.shift.variance ?? 0) }}</strong></div>
            <div><div class="muted small">Sales</div><strong>{{ z.sales.count }} · {{ state.money(z.sales.total + z.sales.rounding) }}</strong></div>
          </div>
          <div class="row">
            <button type="button" class="btn" (click)="printZ(z)">Print Z report</button>
            <button type="button" class="btn primary" (click)="closed.set(null)">Done</button>
          </div>
        </section>
      } @else if (state.shift(); as r) {
        <div class="row-between">
          <h1>Shift</h1>
          <span class="muted">Opened {{ r.shift.openedAt | date: 'short' }}</span>
        </div>
        <section class="grid-2">
          <div class="card"><div class="muted small">Sales</div><div class="stat">{{ r.sales.count }} · {{ state.money(r.sales.total + r.sales.rounding) }}</div></div>
          <div class="card"><div class="muted small">Expected in drawer</div><div class="stat" data-testid="expected-cash">{{ state.money(r.cash.expected) }}</div></div>
          <div class="card"><div class="muted small">Refunds</div><div class="stat">{{ r.refunds.count }} · {{ state.money(r.refunds.total) }}</div></div>
          <div class="card"><div class="muted small">By method</div>
            @for (p of r.payments; track p.method) { <div class="row-between small"><span>{{ method[p.method] }}</span><span>{{ state.money(p.amount) }}</span></div> }
          </div>
        </section>

        <section class="card stack">
          <h2>Cash in and out</h2>
          <div class="row">
            <select [value]="cashType()" (change)="setCashType(val($event))" style="max-width: 180px">
              <option value="PAY_IN">Pay in</option>
              <option value="PAY_OUT">Pay out</option>
              <option value="NO_SALE">Open drawer (no sale)</option>
            </select>
            @if (cashType() !== 'NO_SALE') {
              <input inputmode="decimal" placeholder="Amount" aria-label="Amount" [value]="cashAmount()" (input)="cashAmount.set(val($event))" style="max-width: 160px" />
            }
            <input placeholder="Reason" aria-label="Reason" [value]="cashReason()" (input)="cashReason.set(val($event))" style="flex: 1; min-width: 180px" />
            <button type="button" class="btn" [disabled]="busy() || cashReason().trim().length < 3" (click)="cash()">Record</button>
          </div>
        </section>

        <section class="card stack">
          <h2>Close the shift</h2>
          <p class="muted">Count the drawer. The difference from the expected amount is recorded as the variance.</p>
          <div class="row">
            <input inputmode="decimal" placeholder="Counted cash" aria-label="Counted cash" data-testid="counted" [value]="counted()" (input)="counted.set(val($event))" style="max-width: 200px" />
            <input placeholder="Note (optional)" aria-label="Note" [value]="note()" (input)="note.set(val($event))" style="flex: 1" />
            <button type="button" class="btn primary" data-testid="close-shift" [disabled]="busy() || state.parse(counted()) === null" (click)="close()">Close shift</button>
            <button type="button" class="btn" (click)="printZ(r)">Print X report</button>
          </div>
        </section>
      } @else {
        <p class="muted">No shift is open. Open one from the Sell tab.</p>
      }

      <section class="card stack">
        <h2>Receipt printer</h2>
        @if (bridge.ready()) {
          <p>Connected to the hardware bridge ({{ bridge.health()?.printer ?? 'no printer' }}).</p>
        } @else if (bridge.health()) {
          <p>The bridge is running but not paired with this till. Enter the code shown in the bridge window.</p>
          <div class="row">
            <input aria-label="Pairing code" inputmode="numeric" placeholder="6-digit code" [value]="pairCode()" (input)="pairCode.set(val($event))" style="max-width: 160px" />
            <button type="button" class="btn" [disabled]="pairCode().length !== 6" (click)="pair()">Pair</button>
          </div>
        } @else {
          <p class="muted">No hardware bridge found on this computer. Receipts print through the browser.</p>
          <div><button type="button" class="btn small" (click)="bridge.check()">Check again</button></div>
        }
      </section>
    </div>
  `,
  styles: `.stat { font-size: 22px; font-weight: 700; } .bad { color: var(--danger); }`,
})
export class Shift {
  protected readonly state = inject(TillState);
  protected readonly bridge = inject(HardwareBridge);
  private readonly api = inject(PosApi);
  private readonly approvals = inject(Approvals);
  private readonly toasts = inject(ToastService);
  protected readonly method = METHOD;

  protected readonly cashType = signal<'PAY_IN' | 'PAY_OUT' | 'NO_SALE'>('PAY_IN');
  protected readonly cashAmount = signal('');
  protected readonly cashReason = signal('');
  protected readonly counted = signal('');
  protected readonly note = signal('');
  protected readonly pairCode = signal('');
  protected readonly busy = signal(false);
  protected readonly closed = signal<ShiftReport | null>(null);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected setCashType(v: string) {
    this.cashType.set(v as 'PAY_IN' | 'PAY_OUT' | 'NO_SALE');
  }

  private async guarded(fn: () => Promise<void>) {
    this.busy.set(true);
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof ApprovalCancelled)) this.toasts.error(humanMessage(toApiError(e)));
    } finally {
      this.busy.set(false);
    }
  }

  protected cash() {
    return this.guarded(async () => {
      const type = this.cashType();
      const amount = type === 'NO_SALE' ? 0 : this.state.parse(this.cashAmount());
      if (amount === null) throw new Error('Enter an amount');
      await this.approvals.run((h) => this.api.cash(type, amount, this.cashReason().trim(), h));
      await this.bridge.openDrawer();
      this.toasts.success('Recorded');
      this.cashAmount.set('');
      this.cashReason.set('');
      await this.state.refreshShift();
    });
  }

  protected close() {
    return this.guarded(async () => {
      const counted = this.state.parse(this.counted());
      if (counted === null) return;
      const z = await this.approvals.run((h) => this.api.closeShift(counted, this.note().trim() || undefined, h));
      this.closed.set(z);
      this.state.shift.set(null);
      this.counted.set('');
      this.note.set('');
    });
  }

  protected async printZ(r: ShiftReport) {
    await this.bridge.print(zReport(r, this.state.currency(), this.state.tenantName()));
  }

  protected pair() {
    return this.guarded(async () => {
      await this.bridge.pair(this.pairCode());
      this.pairCode.set('');
      this.toasts.success('Printer bridge paired');
    });
  }
}
