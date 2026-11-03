import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { humanMessage, toApiError, UiCopy, UiField, UiOtpInput, UiQr } from 'ui';
import { AuthStore } from '../core/auth-store';
import { REALM } from '../core/realm';

type Step = { kind: 'credentials' } | { kind: 'mfa'; mfaToken: string } | { kind: 'mfa-setup'; mfaToken: string; otpauthUrl: string; secret: string };

const REASONS: Record<string, string> = {
  expired: 'Your session ended. Sign in again.',
  'impersonation-ended': 'The impersonation session has ended.',
  'signed-out': 'You have signed out.',
  'password-set': 'Password set. Sign in to continue.',
};

@Component({
  selector: 'admin-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiField, UiOtpInput, UiQr, UiCopy],
  template: `
    <div class="page-narrow">
      <div class="brand"><span aria-hidden="true">◆</span> {{ realm === 'platform' ? 'Platform console' : 'Back office' }}</div>
      <section class="card stack">
        @switch (step().kind) {
          @case ('credentials') {
            <h1>Sign in</h1>
            @if (reasonText()) {
              <div class="notice">{{ reasonText() }}</div>
            }
            <form class="stack" (submit)="$event.preventDefault(); submit()">
              <ui-field label="Email" for="email">
                <input id="email" type="email" autocomplete="username" required [value]="email()" (input)="email.set(val($event))" />
              </ui-field>
              <ui-field label="Password" for="password">
                <input id="password" type="password" autocomplete="current-password" required [value]="password()" (input)="password.set(val($event))" />
              </ui-field>
              @if (error()) {
                <div class="error-text" role="alert">{{ error() }}</div>
              }
              <button class="btn primary block" type="submit" [disabled]="busy()">{{ busy() ? 'Signing in…' : 'Sign in' }}</button>
            </form>
          }
          @case ('mfa') {
            <h1>Two-step verification</h1>
            <p class="muted">Enter the six-digit code from your authenticator app.</p>
            <ui-otp-input #otp (completed)="verify($event, otp)" />
            @if (error()) {
              <div class="error-text" role="alert">{{ error() }}</div>
            }
          }
          @case ('mfa-setup') {
            @let s = setup();
            <h1>Set up two-step verification</h1>
            <p class="muted">Your role requires an authenticator app. Scan this code, then enter the six digits it shows.</p>
            @if (s) {
              <ui-qr [value]="s.otpauthUrl" alt="Authenticator QR code" />
              <div class="small muted">Can't scan? Enter this key manually:</div>
              <ui-copy [value]="s.secret" />
            }
            <ui-otp-input #otp2 (completed)="verify($event, otp2)" />
            @if (error()) {
              <div class="error-text" role="alert">{{ error() }}</div>
            }
          }
        }
      </section>
      <p class="small muted center">Have a setup code? <a href="/setup-password">Set your password</a></p>
    </div>
  `,
  styles: `
    .brand { font-weight: 650; font-size: 17px; margin-bottom: var(--s4); text-align: center; }
    .brand span { color: var(--accent); }
    .center { text-align: center; margin-top: var(--s4); }
  `,
})
export class Login {
  private readonly store = inject(AuthStore);
  private readonly router = inject(Router);
  protected readonly realm = inject(REALM);

  /** Query params, bound by the router. */
  readonly next = input<string>();
  readonly reason = input<string>();

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly step = signal<Step>({ kind: 'credentials' });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected reasonText() {
    const r = this.reason();
    return r ? (REASONS[r] ?? null) : null;
  }

  protected setup() {
    const s = this.step();
    return s.kind === 'mfa-setup' ? s : null;
  }

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async submit() {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await this.store.login(this.email().trim(), this.password());
      if (r.status === 'ok') {
        await this.done();
        return;
      }
      this.step.set(r.status === 'mfa_required' ? { kind: 'mfa', mfaToken: r.mfaToken } : { kind: 'mfa-setup', mfaToken: r.mfaToken, otpauthUrl: r.otpauthUrl, secret: r.secret });
    } catch (e) {
      this.error.set(humanMessage(toApiError(e)));
    } finally {
      this.busy.set(false);
    }
  }

  protected async verify(code: string, otp: UiOtpInput) {
    const s = this.step();
    if (s.kind === 'credentials' || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.store.verifyMfa(s.mfaToken, code);
      await this.done();
    } catch (e) {
      const err = toApiError(e);
      this.error.set(err.code === 'UNAUTHENTICATED' ? 'That code did not work. Wait for the next one and try again.' : humanMessage(err));
      otp.clear();
    } finally {
      this.busy.set(false);
    }
  }

  private done() {
    const next = this.next();
    return this.router.navigateByUrl(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
  }
}
