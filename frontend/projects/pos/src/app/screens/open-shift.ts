import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { humanMessage, toApiError } from 'ui';
import { PosApi } from '../api/pos-api';
import { OfflineRefused, OfflineTill } from '../offline/offline-till';
import { isOfflineError } from '../offline/sync-engine';
import { TillState } from '../till-state';

@Component({
  selector: 'pos-open-shift',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card stack open" data-testid="open-shift">
      <h1>Open a shift</h1>
      <p class="muted">Count the cash in the drawer before the first sale.</p>
      @if (state.offline()) {
        <p class="small offline-note" data-testid="open-offline">Offline: the shift opens on this till and reaches the server when it reconnects.</p>
      }
      <label>Opening float
        <input inputmode="decimal" data-testid="float" [value]="float()" (input)="float.set(val($event))" (keydown.enter)="open()" />
      </label>
      @if (error()) {
        <div class="error-text" role="alert">{{ error() }}</div>
      }
      <button type="button" class="btn primary" data-testid="open-shift-btn" [disabled]="busy()" (click)="open()">Open shift</button>
    </section>
  `,
  styles: `
    .open { max-width: 420px; margin: var(--s7) auto; }
    label { display: flex; flex-direction: column; gap: 4px; font-weight: 550; }
    input { font-size: 22px; }
    .offline-note { background: var(--warn-soft); color: var(--warn); padding: var(--s2) var(--s3); border-radius: var(--radius); }
  `,
})
export class OpenShift {
  private readonly api = inject(PosApi);
  private readonly offlineTill = inject(OfflineTill);
  protected readonly state = inject(TillState);
  protected readonly float = signal('0');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async open() {
    const amount = this.state.parse(this.float() || '0');
    if (amount === null) return this.error.set('Enter the float as an amount, e.g. 5000.00');
    this.busy.set(true);
    this.error.set(null);
    try {
      if (this.state.offline()) await this.offlineTill.openShift(amount);
      else {
        try {
          await this.state.setShift(await this.api.openShift(amount));
        } catch (e) {
          if (!isOfflineError(e)) throw e;
          this.state.sync.online.set(false);
          await this.offlineTill.openShift(amount);
        }
      }
    } catch (e) {
      if (e instanceof OfflineRefused) return this.error.set(e.message);
      const err = toApiError(e);
      if (err.code === 'CONFLICT') await this.state.refreshShift();
      else this.error.set(humanMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
