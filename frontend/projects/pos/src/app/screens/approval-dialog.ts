import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { humanMessage, toApiError, UiDialog } from 'ui';
import { ACTION_LABELS, Approvals } from '../api/approvals';
import { PosApi } from '../api/pos-api';
import { PinVerifiers } from '../offline/pin-verifier';
import { SyncEngine } from '../offline/sync-engine';
import { PinPad } from './pin-pad';

/** Manager approval: pick an approver who holds the permission, they enter their PIN on this till. */
@Component({
  selector: 'pos-approval-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiDialog, PinPad],
  template: `
    <ui-dialog title="Manager approval" [open]="!!approvals.pending()" (closed)="cancel()">
      @if (approvals.pending(); as req) {
        <div class="stack" data-testid="approval-dialog">
          <p class="muted">{{ label() }} needs a manager.</p>
          @if (approver(); as a) {
            <div class="center stack">
              <button type="button" class="btn ghost small" (click)="approver.set(null)">← {{ a.name }}</button>
              <pos-pin-pad [disabled]="busy()" (submitted)="approve(a.id, $event)" />
            </div>
          } @else {
            @if (approvers().length) {
              <div class="people">
                @for (u of approvers(); track u.id) {
                  <button type="button" class="btn" [attr.data-approver]="u.name" (click)="approver.set(u)">{{ u.name }}</button>
                }
              </div>
            } @else if (!loading()) {
              <p>Nobody {{ approvals.pending()?.mode === 'offline' ? 'who has signed in on this till before' : 'with a PIN on this till' }} can approve this.</p>
            }
          }
          @if (error()) {
            <div class="error-text" role="alert">{{ error() }}</div>
          }
          <div><button type="button" class="btn" (click)="cancel()">Cancel</button></div>
        </div>
      }
    </ui-dialog>
  `,
  styles: `
    .people { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--s2); }
    .center { align-items: center; }
  `,
})
export class ApprovalDialog {
  protected readonly approvals = inject(Approvals);
  private readonly api = inject(PosApi);
  private readonly sync = inject(SyncEngine);
  private readonly verifiers = inject(PinVerifiers);
  protected readonly approvers = signal<{ id: string; name: string }[]>([]);
  protected readonly approver = signal<{ id: string; name: string } | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly label = computed(() => ACTION_LABELS[this.approvals.pending()?.action ?? ''] ?? 'This action');
  private readonly pad = viewChild(PinPad);

  constructor() {
    effect(() => {
      const req = this.approvals.pending();
      this.approver.set(null);
      this.error.set(null);
      this.approvers.set([]);
      if (!req) return;
      this.loading.set(true);
      this.approverList(req.action, req.mode)
        .then((list) => {
          this.approvers.set(list);
          if (list.length === 1) this.approver.set(list[0]);
        })
        .catch((e) => this.error.set(humanMessage(toApiError(e))))
        .finally(() => this.loading.set(false));
    });
  }

  /** Offline: staff from the last sync holding the permission who have signed in on this till before. */
  private async approverList(action: string, mode: 'online' | 'offline') {
    if (mode === 'online') return this.api.approvers(action);
    const known = new Set(await this.verifiers.known());
    return (this.sync.snapshot()?.users ?? []).filter((u) => u.permissions.includes(action) && known.has(u.id)).map((u) => ({ id: u.id, name: u.name }));
  }

  protected async approve(approverId: string, pin: string) {
    const req = this.approvals.pending();
    if (!req) return;
    this.busy.set(true);
    this.error.set(null);
    if (req.mode === 'offline') {
      const r = await this.verifiers.verify(approverId, pin);
      this.busy.set(false);
      if (r === 'ok') return req.resolve(approverId);
      this.error.set(r === 'locked' ? 'Too many wrong PINs. Try again in 15 minutes.' : 'Wrong PIN.');
      this.pad()?.clear();
      return;
    }
    try {
      const { stepUpToken } = await this.api.stepUp(approverId, pin, req.action);
      req.resolve(stepUpToken);
    } catch (e) {
      const err = toApiError(e);
      this.error.set(err.code === 'UNAUTHENTICATED' ? 'Wrong PIN.' : humanMessage(err));
      this.pad()?.clear();
    } finally {
      this.busy.set(false);
    }
  }

  protected cancel() {
    this.approvals.pending()?.reject();
  }
}
