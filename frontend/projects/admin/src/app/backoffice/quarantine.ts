import { DatePipe, JsonPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty } from 'ui';

interface QuarantineItem {
  id: string;
  deviceId: string;
  registerId: string;
  opId: string;
  kind: 'sale' | 'refund' | 'cash';
  seq: number;
  reason: string;
  details: unknown;
  op: { createdAt: string; payload: { receiptNo?: string; expectedTotal?: number; amount?: number } };
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

const REASONS: Record<string, string> = {
  BAD_SIGNATURE: 'Not signed by the till: possible tampering',
  CHAIN_GAP: 'An earlier offline entry from this till is missing',
  OUTSIDE_OFFLINE_WINDOW: 'Made after the offline time limit',
  FUTURE_TIMESTAMP: 'Dated in the future',
  TOTAL_MISMATCH: 'Total does not match the items',
  PAYMENT_MISMATCH: 'Payments do not add up',
  PRICE_MISMATCH: 'Price differs from the catalog the till had',
  TAX_MISMATCH: 'Tax differs from the catalog the till had',
  METHOD_NOT_ALLOWED_OFFLINE: 'Card payment taken offline',
  APPROVAL_MISSING: 'Needed a manager approval it does not have',
  APPROVER_NOT_ALLOWED: 'Approved by someone without the permission',
  OVER_OFFLINE_REFUND_LIMIT: 'Refund above the offline limit',
  UNKNOWN_SHIFT: 'Shift not found on this register',
  UNKNOWN_PRODUCT: 'Product not found',
  UNKNOWN_SALE: 'Refunded sale not found',
  UNKNOWN_USER: 'Unknown staff member',
  DUPLICATE: 'Receipt number already used',
};

/** Offline entries that failed verification. Nothing is applied or dropped until a manager decides. */
@Component({
  selector: 'admin-quarantine',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, JsonPipe, UiBadge, UiDialog, UiEmpty],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Offline review</h1>
        <select aria-label="Status" [value]="status()" (change)="setStatus(val($event))" style="max-width: 200px">
          <option value="PENDING">Waiting for review</option>
          <option value="ACCEPTED">Accepted</option>
          <option value="REJECTED">Rejected</option>
        </select>
      </div>
      <p class="muted">Entries a till made offline that the server could not verify. Accepting applies the entry; arithmetic errors can only be rejected.</p>
      <section class="card flush">
        @if (items.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>When</th><th>What</th><th>Problem</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (q of items.value(); track q.id) {
                <tr [attr.data-quarantine]="q.reason">
                  <td>{{ q.op.createdAt | date: 'short' }}</td>
                  <td>{{ q.kind }} {{ q.op.payload.receiptNo ?? '' }}</td>
                  <td>{{ reason(q.reason) }}</td>
                  <td><ui-badge [tone]="q.status === 'PENDING' ? 'warn' : q.status === 'ACCEPTED' ? 'ok' : 'neutral'">{{ q.status }}</ui-badge></td>
                  <td><button class="btn small" type="button" (click)="open(q)">Review</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="items.errorMessage() ?? (items.isLoading() ? 'Loading…' : 'Nothing here')" />
        }
      </section>
    </div>

    <ui-dialog title="Review offline entry" [open]="!!selected()" (closed)="selected.set(null)">
      @if (selected(); as q) {
        <div class="stack">
          <div><strong>{{ reason(q.reason) }}</strong></div>
          @if (q.details) { <pre class="small">{{ q.details | json }}</pre> }
          <pre class="small op">{{ q.op.payload | json }}</pre>
          @if (q.status === 'PENDING') {
            <label>Note (required)<input data-testid="review-note" [value]="note()" (input)="note.set(val($event))" /></label>
            <div class="row-between">
              <button class="btn" type="button" [disabled]="note().trim().length < 3" (click)="decide(q, 'reject')">Reject</button>
              @if (q.reason !== 'BAD_SIGNATURE') {
                <button class="btn primary" type="button" [disabled]="note().trim().length < 3" (click)="decide(q, 'accept')">Accept and apply</button>
              }
            </div>
          } @else {
            <p class="muted">{{ q.status }} {{ q.reviewedAt | date: 'short' }}: {{ q.reviewNote }}</p>
          }
        </div>
      }
    </ui-dialog>
  `,
  styles: `pre { background: var(--surface-2); padding: var(--s3); border-radius: var(--radius); overflow: auto; max-height: 240px; } label { display: flex; flex-direction: column; gap: 4px; }`,
})
export class Quarantine {
  private readonly http = inject(HttpClient);
  private readonly toasts = inject(ToastService);
  protected readonly status = signal<'PENDING' | 'ACCEPTED' | 'REJECTED'>('PENDING');
  protected readonly items = apiResource({
    params: () => this.status(),
    loader: ({ params }) => firstValueFrom(this.http.get<QuarantineItem[]>(`/api/sync/quarantine?status=${params}`)),
  });
  protected readonly selected = signal<QuarantineItem | null>(null);
  protected readonly note = signal('');

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected setStatus(v: string) {
    this.status.set(v as 'PENDING' | 'ACCEPTED' | 'REJECTED');
  }
  protected reason(code: string) {
    return REASONS[code] ?? code;
  }
  protected open(q: QuarantineItem) {
    this.note.set('');
    this.selected.set(q);
  }

  protected async decide(q: QuarantineItem, how: 'accept' | 'reject') {
    try {
      await firstValueFrom(this.http.post(`/api/sync/quarantine/${q.id}/${how}`, { note: this.note().trim() }));
      this.toasts.success(how === 'accept' ? 'Accepted and applied' : 'Rejected');
      this.selected.set(null);
      this.items.reload();
    } catch (e) {
      const err = toApiError(e);
      const reason = (err.details as { reason?: string } | undefined)?.reason;
      this.toasts.error(reason ? `${err.message}: ${this.reason(reason)}` : humanMessage(err));
    }
  }
}
