import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiCopy, UiEmpty, UiField } from 'ui';
import { BackofficeApi, type Device, type Enrollment } from './backoffice-api';
import { BackofficeSession } from './session';

@Component({
  selector: 'admin-devices',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiCopy, UiEmpty, UiField, DatePipe],
  template: `
    <div class="page stack">
      <h1>Devices</h1>

      @if (session.can('device.enroll')) {
        <section class="card stack">
          <h2>Enrol a till</h2>
          @if (enrollment(); as e) {
            <div class="stack" data-testid="enrollment">
              <p>On the till, open <span class="mono">{{ host }}/pos/</span> and enter this code for <strong>{{ registerName(e.registerId) }}</strong>. It works once.</p>
              <ui-copy [value]="e.code" [large]="true" data-testid="enrollment-code" />
              <div class="small" [class.error-text]="secondsLeft() === 0">{{ secondsLeft() > 0 ? 'Expires in ' + countdown() : 'Expired — create a new code.' }}</div>
              <div><button class="btn small" type="button" (click)="enrollment.set(null); devices.reload()">Done</button></div>
            </div>
          } @else if (registers.value()?.length === 0) {
            <p class="muted">Add a register first.</p>
          } @else {
            <form class="row" style="align-items: flex-end" (submit)="$event.preventDefault(); createCode()">
              <ui-field label="Register" for="d-register">
                <select id="d-register" [value]="registerId()" (change)="registerId.set(val($event))">
                  <option value="" disabled>Choose…</option>
                  @for (r of registers.value() ?? []; track r.id) {
                    <option [value]="r.id">{{ r.code }} — {{ r.name }}</option>
                  }
                </select>
              </ui-field>
              <button class="btn primary" type="submit" [disabled]="!registerId()">Create enrollment code</button>
            </form>
          }
        </section>
      }

      <section class="card flush">
        @if (devices.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Device</th><th>Register</th><th>Enrolled</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (d of devices.value(); track d.id) {
                <tr [attr.data-device]="d.name">
                  <td>{{ d.name }}</td>
                  <td>{{ registerName(d.registerId) }}</td>
                  <td class="small">{{ d.enrolledAt | date: 'medium' }}</td>
                  <td>@if (d.revokedAt) { <ui-badge tone="danger">Revoked</ui-badge> } @else { <ui-badge tone="ok">Active</ui-badge> }</td>
                  <td>
                    @if (!d.revokedAt && session.can('device.revoke')) {
                      <button class="btn danger small" type="button" (click)="revoke(d)">Revoke</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="devices.errorMessage() ?? (devices.isLoading() ? 'Loading…' : 'No devices enrolled')" />
        }
      </section>
    </div>
  `,
})
export class Devices {
  private readonly api = inject(BackofficeApi);
  private readonly toasts = inject(ToastService);
  protected readonly session = inject(BackofficeSession);
  protected readonly host = location.host;
  protected readonly devices = apiResource({ loader: () => this.api.devices() });
  protected readonly registers = apiResource({ loader: () => this.api.registers() });
  protected readonly registerId = signal('');
  protected readonly enrollment = signal<Enrollment | null>(null);
  private readonly now = signal(Date.now());
  protected readonly secondsLeft = computed(() => {
    const e = this.enrollment();
    return e ? Math.max(0, Math.round((new Date(e.expiresAt).getTime() - this.now()) / 1000)) : 0;
  });
  protected readonly countdown = computed(() => {
    const s = this.secondsLeft();
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  constructor() {
    let ticks = 0;
    // While a code is on screen, watch for the till to appear so the manager sees it land.
    const timer = setInterval(() => {
      this.now.set(Date.now());
      if (this.enrollment() && ++ticks % 3 === 0) void this.checkForNewDevice();
    }, 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private knownDeviceIds = new Set<string>();

  private async checkForNewDevice() {
    const e = this.enrollment();
    if (!e) return;
    const list = await this.api.devices().catch(() => null);
    if (!list) return;
    const added = list.find((d) => d.registerId === e.registerId && !d.revokedAt && !this.knownDeviceIds.has(d.id));
    if (added) {
      this.devices.set(list);
      this.enrollment.set(null);
      this.toasts.success(`${added.name} enrolled`);
    }
  }

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected registerName(id: string) {
    const r = this.registers.value()?.find((x) => x.id === id);
    return r ? `${r.code} — ${r.name}` : '—';
  }

  protected async createCode() {
    try {
      this.knownDeviceIds = new Set((this.devices.value() ?? []).map((d) => d.id));
      this.enrollment.set(await this.api.createEnrollment(this.registerId()));
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }

  protected async revoke(d: Device) {
    if (!confirm(`Revoke ${d.name}? It is signed out immediately and must be enrolled again.`)) return;
    try {
      await this.api.revokeDevice(d.id);
      this.toasts.success(`${d.name} revoked`);
      this.devices.reload();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
