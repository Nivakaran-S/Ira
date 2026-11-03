import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { UiShell } from 'ui';
import { AuthStore } from '../core/auth-store';

@Component({
  selector: 'admin-console-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiShell, RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <ui-shell brand="POS Platform" [subtitle]="host">
      <ng-container nav>
        <a routerLink="/tenants" routerLinkActive="active">Tenants</a>
        <a routerLink="/business-types" routerLinkActive="active">Business types</a>
      </ng-container>
      <div foot class="muted">Super admin</div>
      <ng-container toolbar>
        <button class="btn small" type="button" (click)="signOut()">Sign out</button>
      </ng-container>
      <router-outlet />
    </ui-shell>
  `,
})
export class ConsoleLayout {
  private readonly store = inject(AuthStore);
  private readonly router = inject(Router);
  protected readonly host = location.host;

  protected async signOut() {
    await this.store.logout().catch(() => undefined);
    await this.router.navigateByUrl('/login?reason=signed-out');
  }
}
