import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { apiResource, humanMessage, toApiError, UiBadge, UiEmpty } from 'ui';
import { ConsoleApi } from './console-api';

@Component({
  selector: 'admin-tenants-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiBadge, UiEmpty, DatePipe],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Tenants</h1>
        <a class="btn primary" routerLink="/tenants/new">New tenant</a>
      </div>
      <section class="card flush">
        @if (tenants.isLoading()) {
          <ui-empty title="Loading…" />
        } @else if (tenants.error()) {
          <ui-empty title="Could not load tenants">{{ errorText() }}</ui-empty>
        } @else if (!tenants.value()?.length) {
          <ui-empty title="No tenants yet"><a routerLink="/tenants/new">Create the first one</a></ui-empty>
        } @else {
          <table class="ui-table">
            <thead>
              <tr><th>Name</th><th>Host</th><th>Business type</th><th>Status</th><th>Created</th></tr>
            </thead>
            <tbody>
              @for (t of tenants.value(); track t.id) {
                <tr>
                  <td><a [routerLink]="['/tenants', t.id]">{{ t.name }}</a></td>
                  <td class="mono small">{{ t.slug }}.{{ platformDomain }}</td>
                  <td>{{ t.businessType.name }}</td>
                  <td><ui-badge [tone]="t.status === 'ACTIVE' ? 'ok' : 'warn'">{{ t.status === 'ACTIVE' ? 'Active' : 'Suspended' }}</ui-badge></td>
                  <td class="small muted">{{ t.createdAt | date: 'mediumDate' }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
    </div>
  `,
})
export class TenantsList {
  private readonly api = inject(ConsoleApi);
  protected readonly platformDomain = location.hostname.replace(/^admin\./, '');
  protected readonly tenants = apiResource({ loader: () => this.api.listTenants() });

  protected errorText() {
    return humanMessage(toApiError(this.tenants.error()));
  }
}
