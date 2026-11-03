import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { UiShell } from 'ui';
import { AuthStore } from '../core/auth-store';
import { navItems } from './nav';
import { BackofficeSession } from './session';

@Component({
  selector: 'admin-backoffice-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiShell, RouterOutlet, RouterLink, RouterLinkActive],
  providers: [BackofficeSession],
  template: `
    <ui-shell [brand]="session.me.value()?.tenant?.name ?? 'Back office'" [subtitle]="host">
      @if (store.impersonating()) {
        <div banner class="imp" role="status" data-testid="impersonation-banner">
          <strong>Impersonating {{ session.me.value()?.user?.name ?? 'the owner' }}.</strong>
          Every action is recorded against your super-admin account.
          <button class="btn small" type="button" (click)="exit()">Exit</button>
        </div>
      }
      <ng-container nav>
        @for (item of nav(); track item.path) {
          <a [routerLink]="item.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: item.path === '/' }">{{ item.label }}</a>
        }
      </ng-container>
      <div foot>
        <div>{{ session.me.value()?.user?.name }}</div>
        <div class="muted small">{{ session.me.value()?.user?.email }}</div>
      </div>
      <ng-container toolbar>
        <button class="btn small" type="button" (click)="signOut()">Sign out</button>
      </ng-container>
      <router-outlet />
    </ui-shell>
  `,
  styles: `
    .imp { background: var(--warn-soft); border-bottom: 1px solid #f1d48a; padding: var(--s2) var(--s5); display: flex; gap: var(--s3); align-items: center; flex-wrap: wrap; }
  `,
})
export class BackofficeLayout {
  protected readonly store = inject(AuthStore);
  protected readonly session = inject(BackofficeSession);
  private readonly router = inject(Router);
  protected readonly host = location.host;
  protected readonly nav = computed(() => navItems(this.session.permissions()));

  protected async signOut() {
    await this.store.logout().catch(() => undefined);
    await this.router.navigateByUrl('/login?reason=signed-out');
  }

  protected exit() {
    this.store.endImpersonation();
    window.close();
    void this.router.navigateByUrl('/login?reason=impersonation-ended');
  }
}
