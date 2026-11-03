import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MODULES } from '@pos/shared';
import { UiBadge } from 'ui';
import { BackofficeSession } from './session';

@Component({
  selector: 'admin-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge],
  template: `
    <div class="page stack">
      @if (session.me.value(); as me) {
        <h1 data-testid="welcome">Welcome, {{ me.user.name }}</h1>
        <div class="grid-2">
          <section class="card stack">
            <h2>{{ me.tenant.name }}</h2>
            <div class="small muted mono">{{ host }}</div>
            <div class="small">Signed in as {{ me.user.email ?? me.user.name }}</div>
          </section>
          <section class="card stack">
            <h2>Enabled features</h2>
            <div class="row">
              @for (m of session.modules(); track m) {
                <ui-badge tone="accent">{{ name(m) }}</ui-badge>
              }
            </div>
          </section>
        </div>
        <section class="card stack">
          <h2>Your permissions</h2>
          <div class="row">
            @for (p of permissionList(); track p) {
              <ui-badge>{{ p }}</ui-badge>
            } @empty {
              <span class="muted">None</span>
            }
          </div>
        </section>
        <section class="card stack">
          <h2>Getting started</h2>
          <ol class="steps">
            <li>Add a store, then a register (till) in it.</li>
            <li>Create staff users with a role and a PIN.</li>
            <li>Under Devices, create an enrollment code for the register and enter it on the till at <span class="mono">{{ host }}/pos/</span>.</li>
          </ol>
        </section>
      } @else {
        <p class="muted">Loading…</p>
      }
    </div>
  `,
  styles: `.steps { margin: 0; padding-left: var(--s5); display: grid; gap: var(--s2); }`,
})
export class Overview {
  protected readonly session = inject(BackofficeSession);
  protected readonly host = location.host;

  protected permissionList() {
    return [...this.session.permissions()].sort();
  }
  protected name(m: string) {
    return (MODULES as Record<string, { name: string }>)[m]?.name ?? m;
  }
}
