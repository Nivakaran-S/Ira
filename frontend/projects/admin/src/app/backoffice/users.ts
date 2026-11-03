import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { apiResource, fieldErrors, humanMessage, toApiError, ToastService, UiBadge, UiCopy, UiDialog, UiEmpty, UiField } from 'ui';
import { BackofficeApi, type User } from './backoffice-api';
import { BackofficeSession } from './session';

@Component({
  selector: 'admin-users',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiCopy, UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Users</h1>
        <button class="btn primary" type="button" data-testid="new-user" (click)="openNew()">New user</button>
      </div>

      @if (created(); as c) {
        <section class="notice stack" data-testid="user-created">
          <strong>{{ c.name }} was created.</strong>
          @if (c.setupCode) {
            <div>Give them this one-time setup code so they can set a password at <span class="mono">{{ host }}/setup-password</span>. It is shown once and expires in 7 days.</div>
            <ui-copy [value]="c.setupCode" [large]="true" data-testid="user-setup-code" />
          } @else {
            <div>They have no email, so they sign in with their PIN on an enrolled till.</div>
          }
          <div><button class="btn small" type="button" data-testid="dismiss-code" (click)="created.set(null)">Done</button></div>
        </section>
      }

      <section class="card flush">
        @if (users.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>PIN</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (u of users.value(); track u.id) {
                <tr [attr.data-user]="u.name">
                  <td>{{ u.name }}</td>
                  <td class="small">{{ u.email ?? '—' }}</td>
                  <td class="small">{{ roleNames(u) }}</td>
                  <td>@if (u.hasPin) { <ui-badge tone="ok">Set</ui-badge> } @else { <span class="muted">—</span> }</td>
                  <td><ui-badge [tone]="u.status === 'ACTIVE' ? 'ok' : 'neutral'">{{ u.status === 'ACTIVE' ? 'Active' : 'Disabled' }}</ui-badge></td>
                  <td><button class="btn small" type="button" (click)="pinFor.set(u)">Set PIN</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="users.errorMessage() ?? (users.isLoading() ? 'Loading…' : 'No users yet')" />
        }
      </section>
    </div>

    <ui-dialog title="New user" [open]="open()" (closed)="open.set(false)">
      <form class="stack" data-testid="user-form" (submit)="$event.preventDefault(); create()">
        <ui-field label="Name" for="u-name" [error]="errors()['name']">
          <input id="u-name" required [value]="name()" (input)="name.set(val($event))" />
        </ui-field>
        <ui-field label="Email (optional)" for="u-email" hint="Needed for back-office sign-in. Leave empty for till-only staff." [error]="errors()['email']">
          <input id="u-email" type="email" [value]="email()" (input)="email.set(val($event))" />
        </ui-field>
        <ui-field label="PIN (optional)" for="u-pin" hint="4 to 8 digits, for signing in on a till." [error]="errors()['pin']">
          <input id="u-pin" inputmode="numeric" autocomplete="off" [value]="pin()" (input)="pin.set(val($event))" />
        </ui-field>
        <fieldset>
          <legend>Roles</legend>
          @for (r of roles.value() ?? []; track r.id) {
            <label class="check"><input type="checkbox" [attr.data-role]="r.id" [checked]="roleIds().includes(r.id)" (change)="toggleRole(r.id, checked($event))" /> {{ r.name }}</label>
          }
        </fieldset>
        @if (error()) {
          <div class="error-text" role="alert">{{ error() }}</div>
        }
        <div><button class="btn primary" type="submit" [disabled]="busy() || !valid()">Create user</button></div>
      </form>
    </ui-dialog>

    <ui-dialog [title]="'Set PIN for ' + (pinFor()?.name ?? '')" [open]="!!pinFor()" (closed)="pinFor.set(null)">
      <form class="stack" (submit)="$event.preventDefault(); savePin()">
        <ui-field label="New PIN" for="set-pin" hint="4 to 8 digits.">
          <input id="set-pin" inputmode="numeric" autocomplete="off" [value]="newPin()" (input)="newPin.set(val($event))" />
        </ui-field>
        <div><button class="btn primary" type="submit" [disabled]="!pinValid(newPin())">Save PIN</button></div>
      </form>
    </ui-dialog>
  `,
  styles: `
    fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s3) var(--s4); display: grid; gap: var(--s2); }
    legend { font-weight: 600; }
    .check { display: flex; gap: var(--s2); align-items: center; }
  `,
})
export class Users {
  private readonly api = inject(BackofficeApi);
  private readonly toasts = inject(ToastService);
  protected readonly session = inject(BackofficeSession);
  protected readonly host = location.host;

  protected readonly users = apiResource({ loader: () => this.api.users() });
  protected readonly roles = apiResource({ loader: () => this.api.roles() });

  protected readonly open = signal(false);
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly pin = signal('');
  protected readonly roleIds = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly created = signal<{ name: string; setupCode: string | null } | null>(null);
  protected readonly pinFor = signal<User | null>(null);
  protected readonly newPin = signal('');

  protected readonly valid = computed(() => !!this.name().trim() && this.roleIds().length > 0 && (this.pin() === '' || this.pinValid(this.pin())));

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected checked(e: Event) {
    return (e.target as HTMLInputElement).checked;
  }
  protected pinValid(p: string) {
    return /^\d{4,8}$/.test(p);
  }
  protected roleNames(u: User) {
    return u.roles.map((r) => r.name).join(', ') || '—';
  }
  protected toggleRole(id: string, on: boolean) {
    this.roleIds.update((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  }

  protected openNew() {
    this.name.set('');
    this.email.set('');
    this.pin.set('');
    this.roleIds.set([]);
    this.error.set(null);
    this.errors.set({});
    this.open.set(true);
  }

  protected async create() {
    if (!this.valid() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await this.api.createUser({
        name: this.name().trim(),
        ...(this.email().trim() ? { email: this.email().trim() } : {}),
        roleIds: this.roleIds(),
        ...(this.pin() ? { pin: this.pin() } : {}),
      });
      this.open.set(false);
      this.created.set({ name: r.user.name, setupCode: r.setupCode });
      this.users.reload();
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.error.set(err.code === 'CONFLICT' ? 'A user with that email already exists.' : humanMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async savePin() {
    const u = this.pinFor();
    if (!u) return;
    try {
      await this.api.setPin(u.id, this.newPin());
      this.toasts.success(`PIN set for ${u.name}`);
      this.pinFor.set(null);
      this.newPin.set('');
      this.users.reload();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
