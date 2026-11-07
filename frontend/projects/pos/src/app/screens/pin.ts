import { ChangeDetectionStrategy, Component, inject, input, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { ApiError, apiResource, humanMessage, toApiError } from 'ui';
import { OfflinePinError, type PinUser, PosSession } from '../device/pos-session';
import { PinVerifiers } from '../offline/pin-verifier';
import { PosApi } from '../api/pos-api';
import { isOfflineError, SyncEngine } from '../offline/sync-engine';
import { PinPad } from './pin-pad';

@Component({
  selector: 'pos-pin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PinPad],
  template: `
    <div class="wrap">
      <header class="row-between">
        <div><strong>{{ session.device()?.name }}</strong></div>
        @if (!sync.online()) {
          <span class="small offline" data-testid="pin-offline">Offline</span>
        }
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
    .offline { background: var(--warn-soft); color: var(--warn); padding: 2px 8px; border-radius: 999px; }
    .avatar { width: 56px; height: 56px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: grid; place-items: center; font-size: 20px; }
  `,
})
export class Pin {
  protected readonly session = inject(PosSession);
  private readonly router = inject(Router);
  readonly reason = input<string>();

  protected readonly sync = inject(SyncEngine);
  private readonly api = inject(PosApi);
  private readonly verifiers = inject(PinVerifiers);
  /** Online: the API's PIN pad. Offline: staff from the last sync who have signed in on this till before. */
  protected readonly users = apiResource({
    loader: async () => {
      try {
        return await this.session.pinPad();
      } catch (e) {
        if (!isOfflineError(e)) throw e;
        this.sync.online.set(false);
        const known = new Set(await this.verifiers.known());
        return (this.sync.snapshot()?.users ?? []).filter((u) => known.has(u.id)).map((u) => ({ id: u.id, name: u.name }));
      }
    },
  });
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

  /** Kitchen staff (kitchen.view without sale.create) go straight to the kitchen display. */
  private async homeFor() {
    try {
      const caps = await this.api.capabilities();
      return !caps.permissions.includes('sale.create') && caps.permissions.includes('kitchen.view') ? '/kitchen' : '/till';
    } catch {
      return '/till';
    }
  }

  protected async login(u: PinUser, pin: string) {
    this.busy.set(true);
    this.error.set(null);
    try {
      const how = await this.session.pinLogin(u, pin);
      await this.router.navigateByUrl(how === 'online' ? await this.homeFor() : '/till');
    } catch (e) {
      if (e instanceof OfflinePinError) {
        this.error.set(
          e.result === 'wrong' ? 'Wrong PIN. Try again.'
          : e.result === 'locked' ? 'Too many wrong PINs. Try again in 15 minutes.'
          : 'Offline: only staff who have signed in on this till before can sign in.',
        );
        this.pad()?.clear();
        return;
      }
      if (!(e instanceof ApiError)) console.error('Sign-in failed', e);
      const err = toApiError(e);
      this.error.set(err.code === 'UNAUTHENTICATED' ? 'Wrong PIN. Try again.' : humanMessage(err));
      this.pad()?.clear();
    } finally {
      this.busy.set(false);
    }
  }
}
