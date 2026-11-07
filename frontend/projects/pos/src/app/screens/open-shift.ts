import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { humanMessage, toApiError } from 'ui';
import { PosApi } from '../api/pos-api';
import { TillState } from '../till-state';

@Component({
  selector: 'pos-open-shift',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card stack open" data-testid="open-shift">
      <h1>Open a shift</h1>
      <p class="muted">Count the cash in the drawer before the first sale.</p>
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
  `,
})
export class OpenShift {
  private readonly api = inject(PosApi);
  private readonly state = inject(TillState);
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
      this.state.shift.set(await this.api.openShift(amount));
    } catch (e) {
      const err = toApiError(e);
      if (err.code === 'CONFLICT') await this.state.refreshShift();
      else this.error.set(humanMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
