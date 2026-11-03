import { ChangeDetectionStrategy, Component, inject, input, resource, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { humanMessage, toApiError } from 'ui';
import { type PinUser, PosSession } from '../device/pos-session';
import { PinPad } from './pin-pad';

@Component({
  selector: 'pos-pin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PinPad],
  template: `
    <div class="wrap">
      <header class="row-between">
        <div><strong>{{ session.device()?.name }}</strong></div>
        @if (reason() === 'expired') {
          <span class="small muted">Session ended. Sign in again.</span>
        }
      </header>
      @if (selected(); as u) {
        <section class="card stack center">
          <button type="button" class="btn ghost small back" (click)="selected.set(null)">← Not {{ u.name }}?</button>
          <h1>{{ u.name }}</h1>
          <p class="muted">Enter your PIN</p>
          <pos-pin-pad [disabled]="busy()" (submitted)="login(u, $event)" />
          @if (error()) {
            <div class="error-text" role="alert">{{ error() }}</div>
          }
        </section>
      } @else {
        <section class="stack">
          <h1>Who's on the till?</h1>
          @if (users.value(); as list) {
            <div class="people">
              @for (u of list; track u.id) {
                <button type="button" class="person" (click)="pick(u)">
                  <span class="avatar" aria-hidden="true">{{ initials(u.name) }}</span>
                  <span>{{ u.name }}</span>
                </button>
              } @empty {
                <p class="muted">No staff have a PIN yet. A manager can set one in the back office under Users.</p>
              }
            </div>
          } @else if (users.error()) {
            <div class="error-text">{{ loadError() }}</div>
            <button class="btn" type="button" (click)="users.reload()">Try again</button>
          } @else {
            <p class="muted">Loading…</p>
          }
        </section>
      }
    </div>
  `,
  styles: `
    .wrap { max-width: 760px; margin: 0 auto; padding: var(--s5); display: flex; flex-direction: column; gap: var(--s5); }
    .center { align-items: center; text-align: center; }
    .back { align-self: flex-start; }
    .people { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: var(--s3); }
    .person { display: flex; flex-direction: column; align-items: center; gap: var(--s2); padding: var(--s5) var(--s3); font: inherit; font-weight: 600; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); cursor: pointer; box-shadow: var(--shadow); }
    .person:hover { border-color: var(--accent); }
    .avatar { width: 56px; height: 56px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; font-size: 20px; }
  `,
})
export class Pin {
  protected readonly session = inject(PosSession);
  private readonly router = inject(Router);
  readonly reason = input<string>();

  protected readonly users = resource({ loader: () => this.session.pinPad() });
  protected readonly selected = signal<PinUser | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly pad = viewChild(PinPad);

  protected initials(name: string) {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('');
  }
  protected loadError() {
    return humanMessage(toApiError(this.users.error()));
  }
  protected pick(u: PinUser) {
    this.error.set(null);
    this.selected.set(u);
  }

  protected async login(u: PinUser, pin: string) {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.session.pinLogin(u.id, pin);
      await this.router.navigateByUrl('/till');
    } catch (e) {
      const err = toApiError(e);
      this.error.set(err.code === 'UNAUTHENTICATED' ? 'Wrong PIN. Try again.' : humanMessage(err));
      this.pad()?.clear();
    } finally {
      this.busy.set(false);
    }
  }
}
