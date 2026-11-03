import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { humanMessage, toApiError, UiField } from 'ui';
import { PosSession } from '../device/pos-session';

const REASONS: Record<string, string> = {
  revoked: 'This till was revoked by a manager. Enrol it again with a new code.',
  unknown: 'This till is not recognised any more. Enrol it again with a new code.',
};

@Component({
  selector: 'pos-enroll',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiField],
  template: `
    <div class="page-narrow">
      <section class="card stack">
        <h1>Set up this till</h1>
        @if (reasonText()) {
          <div class="notice warn">{{ reasonText() }}</div>
        }
        <p class="muted">A manager creates an enrollment code in the back office under Devices. Enter it here.</p>
        <form class="stack" (submit)="$event.preventDefault(); submit()">
          <ui-field label="Enrollment code" for="code">
            <input id="code" class="code" autocomplete="off" spellcheck="false" maxlength="8" [value]="code()" (input)="code.set(upper($event))" />
          </ui-field>
          <ui-field label="Till name" for="device-name" hint="For example: Front counter">
            <input id="device-name" maxlength="64" [value]="name()" (input)="name.set(val($event))" />
          </ui-field>
          @if (error()) {
            <div class="error-text" role="alert">{{ error() }}</div>
          }
          <button class="btn primary block big" type="submit" [disabled]="busy() || !valid()">{{ busy() ? 'Enrolling…' : 'Enrol this till' }}</button>
        </form>
        <p class="small muted">A signing key is created on this device and never leaves it.</p>
      </section>
    </div>
  `,
  styles: `
    .code { font-family: var(--font-mono); font-size: 26px; letter-spacing: 0.25em; text-align: center; text-transform: uppercase; }
    .big { min-height: 52px; font-size: 17px; }
  `,
})
export class Enroll {
  private readonly session = inject(PosSession);
  private readonly router = inject(Router);
  readonly reason = input<string>();

  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly valid = computed(() => /^[A-HJ-NP-Z2-9]{8}$/.test(this.code()) && this.name().trim().length > 0);

  protected reasonText() {
    const r = this.reason();
    return r ? (REASONS[r] ?? null) : null;
  }
  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected upper(e: Event) {
    const el = e.target as HTMLInputElement;
    el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return el.value;
  }

  protected async submit() {
    if (!this.valid() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.session.enroll(this.code(), this.name());
      await this.router.navigateByUrl('/pin');
    } catch (e) {
      const err = toApiError(e);
      this.error.set(err.code === 'UNAUTHENTICATED' || err.code === 'NOT_FOUND' ? 'That code is invalid, used, or expired. Ask for a new one.' : humanMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
