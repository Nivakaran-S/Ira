import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { fieldErrors, humanMessage, toApiError, UiField } from 'ui';
import { AuthStore } from '../core/auth-store';

/** First sign-in: exchange a one-time setup code for a password. */
@Component({
  selector: 'admin-setup-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiField],
  template: `
    <div class="page-narrow">
      <section class="card stack">
        <h1>Set your password</h1>
        <p class="muted">Use the one-time setup code you were given. It works once.</p>
        <form class="stack" (submit)="$event.preventDefault(); submit()">
          <ui-field label="Setup code" for="code" [error]="errors()['code']">
            <input id="code" autocomplete="off" spellcheck="false" required [value]="codeValue()" (input)="codeValue.set(val($event))" />
          </ui-field>
          <ui-field label="New password" for="new-password" hint="At least 12 characters." [error]="errors()['password']">
            <input id="new-password" type="password" autocomplete="new-password" required [value]="password()" (input)="password.set(val($event))" />
          </ui-field>
          <ui-field label="Confirm password" for="confirm-password" [error]="mismatch() ? 'Passwords do not match' : null">
            <input id="confirm-password" type="password" autocomplete="new-password" required [value]="confirm()" (input)="confirm.set(val($event))" />
          </ui-field>
          @if (error()) {
            <div class="error-text" role="alert">{{ error() }}</div>
          }
          <button class="btn primary block" type="submit" [disabled]="busy() || !canSubmit()">Set password</button>
        </form>
      </section>
    </div>
  `,
})
export class SetupPassword {
  private readonly store = inject(AuthStore);
  private readonly router = inject(Router);

  /** ?code= query param, bound by the router. */
  readonly code = input<string>();

  protected readonly codeValue = signal('');
  protected readonly password = signal('');
  protected readonly confirm = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly mismatch = computed(() => this.confirm().length > 0 && this.confirm() !== this.password());
  protected readonly canSubmit = computed(() => this.codeValue().trim().length >= 16 && this.password().length >= 12 && this.password() === this.confirm());

  constructor() {
    effect(() => {
      const c = this.code();
      if (c) this.codeValue.set(c);
    });
  }

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async submit() {
    if (!this.canSubmit() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.errors.set({});
    try {
      await this.store.setupPassword(this.codeValue().trim(), this.password());
      await this.router.navigateByUrl('/login?reason=password-set');
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.error.set(err.code === 'UNAUTHENTICATED' ? 'That setup code is invalid or has expired.' : humanMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
