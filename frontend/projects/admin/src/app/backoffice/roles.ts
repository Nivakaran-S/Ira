import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PERMISSIONS } from '@pos/shared';
import { apiResource, fieldErrors, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty, UiField } from 'ui';
import { BackofficeApi } from './backoffice-api';
import { BackofficeSession } from './session';

@Component({
  selector: 'admin-roles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Roles</h1>
        <button class="btn primary" type="button" (click)="openNew()">New role</button>
      </div>
      <section class="card flush">
        @if (roles.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Role</th><th>Permissions</th><th>MFA</th><th>Users</th></tr></thead>
            <tbody>
              @for (r of roles.value(); track r.id) {
                <tr>
                  <td>{{ r.name }} @if (r.isSystem) { <ui-badge tone="accent">System</ui-badge> }</td>
                  <td class="small">{{ r.permissions.join(', ') || '—' }}</td>
                  <td>{{ r.requiresMfa ? 'Required' : '—' }}</td>
                  <td>{{ r._count.users }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="roles.errorMessage() ?? (roles.isLoading() ? 'Loading…' : 'No roles')" />
        }
      </section>
    </div>

    <ui-dialog title="New role" [open]="open()" (closed)="open.set(false)">
      <form class="stack" (submit)="$event.preventDefault(); create()">
        <ui-field label="Name" for="role-name" [error]="errors()['name']">
          <input id="role-name" [value]="name()" (input)="name.set(val($event))" />
        </ui-field>
        <fieldset>
          <legend>Permissions</legend>
          <p class="small muted">You can only grant permissions you hold yourself.</p>
          <div class="checks">
            @for (p of permissions; track p) {
              <label class="check" [class.muted]="!session.can(p)">
                <input type="checkbox" [disabled]="!session.can(p)" [checked]="selected().includes(p)" (change)="toggle(p, checked($event))" /> {{ p }}
              </label>
            }
          </div>
        </fieldset>
        <label class="check"><input type="checkbox" [checked]="requiresMfa()" (change)="requiresMfa.set(checked($event))" /> Requires an authenticator app</label>
        @if (error()) {
          <div class="error-text" role="alert">{{ error() }}</div>
        }
        <div><button class="btn primary" type="submit" [disabled]="!valid()">Create role</button></div>
      </form>
    </ui-dialog>
  `,
  styles: `
    fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s3) var(--s4); }
    legend { font-weight: 600; }
    .checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: var(--s1) var(--s3); }
    .check { display: flex; gap: var(--s2); align-items: center; }
  `,
})
export class Roles {
  private readonly api = inject(BackofficeApi);
  private readonly toasts = inject(ToastService);
  protected readonly session = inject(BackofficeSession);
  protected readonly permissions = PERMISSIONS;
  protected readonly roles = apiResource({ loader: () => this.api.roles() });
  protected readonly open = signal(false);
  protected readonly name = signal('');
  protected readonly selected = signal<string[]>([]);
  protected readonly requiresMfa = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly valid = computed(() => !!this.name().trim() && this.name().trim().toLowerCase() !== 'owner');

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected checked(e: Event) {
    return (e.target as HTMLInputElement).checked;
  }
  protected toggle(p: string, on: boolean) {
    this.selected.update((s) => (on ? [...s, p] : s.filter((x) => x !== p)));
  }
  protected openNew() {
    this.name.set('');
    this.selected.set([]);
    this.requiresMfa.set(false);
    this.error.set(null);
    this.errors.set({});
    this.open.set(true);
  }

  protected async create() {
    this.error.set(null);
    try {
      await this.api.createRole({ name: this.name().trim(), permissions: this.selected(), requiresMfa: this.requiresMfa() });
      this.toasts.success(`Role ${this.name().trim()} created`);
      this.open.set(false);
      this.roles.reload();
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.error.set(err.code === 'CONFLICT' ? 'A role with that name already exists.' : humanMessage(err));
    }
  }
}
