import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { MODULE_KEYS, MODULES, PERMISSIONS } from '@pos/shared';
import { fieldErrors, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty, UiField } from 'ui';
import { type BusinessType, type BusinessTypeInput, ConsoleApi, type RoleTemplate } from './console-api';
import { dependencyIssues } from './modules-view';
import { slugify } from './tenant-new';

interface Draft {
  id: string | null;
  key: string;
  name: string;
  description: string;
  modules: string[];
  roleTemplates: RoleTemplate[];
  defaultSettings: Record<string, unknown>;
}

const blank = (): Draft => ({
  id: null,
  key: '',
  name: '',
  description: '',
  modules: ['core'],
  roleTemplates: [{ name: 'Cashier', permissions: ['sale.create', 'drawer.open'], requiresMfa: false }],
  defaultSettings: {},
});

@Component({
  selector: 'admin-business-types',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Business types</h1>
        <button class="btn primary" type="button" (click)="edit(null)">New business type</button>
      </div>
      <p class="muted">A business type bundles the modules and starter roles a new tenant gets. Changing one updates every tenant using it.</p>
      <section class="card flush">
        @if (types.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Name</th><th>Key</th><th>Modules</th><th>Roles</th><th></th></tr></thead>
            <tbody>
              @for (bt of types.value(); track bt.id) {
                <tr>
                  <td>{{ bt.name }}</td>
                  <td class="mono small">{{ bt.key }}</td>
                  <td><div class="row">@for (m of bt.modules; track m) { <ui-badge>{{ moduleName(m) }}</ui-badge> }</div></td>
                  <td class="small">{{ roleNames(bt) }}</td>
                  <td><button class="btn small" type="button" (click)="edit(bt)">Edit</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="types.isLoading() ? 'Loading…' : 'No business types yet'" />
        }
      </section>
    </div>

    <ui-dialog [title]="draft().id ? 'Edit business type' : 'New business type'" [open]="open()" (closed)="open.set(false)">
      <form class="stack" (submit)="$event.preventDefault(); save()">
        <div class="grid-2">
          <ui-field label="Name" for="bt-name" [error]="errors()['name']">
            <input id="bt-name" required [value]="draft().name" (input)="setName(val($event))" />
          </ui-field>
          <ui-field label="Key" for="bt-key" [error]="errors()['key']" hint="Lowercase; cannot change later">
            <input id="bt-key" required [value]="draft().key" [disabled]="!!draft().id" (input)="patch({ key: val($event) })" />
          </ui-field>
        </div>
        <fieldset>
          <legend>Modules</legend>
          <div class="checks">
            @for (k of moduleKeys; track k) {
              <label class="check">
                <input type="checkbox" [checked]="draft().modules.includes(k)" [disabled]="k === 'core'" (change)="toggleModule(k, checked($event))" />
                {{ moduleName(k) }}
              </label>
            }
          </div>
          @for (issue of issues(); track issue) {
            <div class="error-text">{{ issue }}</div>
          }
        </fieldset>
        <fieldset>
          <legend>Starter roles</legend>
          @for (r of draft().roleTemplates; track $index; let i = $index) {
            <div class="role stack">
              <div class="row-between">
                <input [attr.aria-label]="'Role name ' + (i + 1)" [value]="r.name" (input)="patchRole(i, { name: val($event) })" style="max-width: 220px" />
                <label class="check"><input type="checkbox" [checked]="r.requiresMfa" (change)="patchRole(i, { requiresMfa: checked($event) })" /> Requires MFA</label>
                <button class="btn ghost small" type="button" (click)="removeRole(i)">Remove</button>
              </div>
              <div class="checks">
                @for (p of permissions; track p) {
                  <label class="check small"><input type="checkbox" [checked]="r.permissions.includes(p)" (change)="togglePerm(i, p, checked($event))" /> {{ p }}</label>
                }
              </div>
            </div>
          }
          <button class="btn small" type="button" (click)="addRole()">Add role</button>
          <p class="small muted">Every tenant also gets a system Owner role with all permissions.</p>
        </fieldset>
        @if (error()) {
          <div class="error-text" role="alert">{{ error() }}</div>
        }
        <div class="row"><button class="btn primary" type="submit" [disabled]="busy() || issues().length > 0">Save</button></div>
      </form>
    </ui-dialog>
  `,
  styles: `
    fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s3) var(--s4); }
    legend { font-weight: 600; padding: 0 var(--s1); }
    .checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: var(--s1) var(--s3); }
    .check { display: flex; align-items: center; gap: var(--s2); }
    .role { border-bottom: 1px dashed var(--border); padding-bottom: var(--s3); margin-bottom: var(--s3); }
  `,
})
export class BusinessTypes {
  private readonly api = inject(ConsoleApi);
  private readonly toasts = inject(ToastService);
  protected readonly types = resource({ loader: () => this.api.listBusinessTypes() });
  protected readonly moduleKeys = MODULE_KEYS;
  protected readonly permissions = PERMISSIONS;

  protected readonly open = signal(false);
  protected readonly draft = signal<Draft>(blank());
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly issues = computed(() => dependencyIssues(this.draft().modules));

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected checked(e: Event) {
    return (e.target as HTMLInputElement).checked;
  }
  protected moduleName(k: string) {
    return (MODULES as Record<string, { name: string }>)[k]?.name ?? k;
  }
  protected roleNames(bt: BusinessType) {
    return bt.roleTemplates.map((r) => r.name).join(', ');
  }

  protected edit(bt: BusinessType | null) {
    this.error.set(null);
    this.errors.set({});
    this.draft.set(bt ? { ...bt, description: bt.description ?? '', roleTemplates: bt.roleTemplates.map((r) => ({ ...r, permissions: [...r.permissions] })) } : blank());
    this.open.set(true);
  }

  protected patch(p: Partial<Draft>) {
    this.draft.update((d) => ({ ...d, ...p }));
  }
  protected setName(name: string) {
    const d = this.draft();
    this.patch(d.id || (d.key && d.key !== slugify(d.name)) ? { name } : { name, key: slugify(name) });
  }
  protected toggleModule(k: string, on: boolean) {
    this.draft.update((d) => ({ ...d, modules: on ? [...d.modules, k] : d.modules.filter((m) => m !== k) }));
  }
  protected patchRole(i: number, p: Partial<RoleTemplate>) {
    this.draft.update((d) => ({ ...d, roleTemplates: d.roleTemplates.map((r, j) => (j === i ? { ...r, ...p } : r)) }));
  }
  protected togglePerm(i: number, perm: string, on: boolean) {
    const r = this.draft().roleTemplates[i];
    this.patchRole(i, { permissions: on ? [...r.permissions, perm] : r.permissions.filter((x) => x !== perm) });
  }
  protected addRole() {
    this.draft.update((d) => ({ ...d, roleTemplates: [...d.roleTemplates, { name: '', permissions: [], requiresMfa: false }] }));
  }
  protected removeRole(i: number) {
    this.draft.update((d) => ({ ...d, roleTemplates: d.roleTemplates.filter((_, j) => j !== i) }));
  }

  protected async save() {
    const d = this.draft();
    const input: BusinessTypeInput = {
      key: d.key.trim(),
      name: d.name.trim(),
      ...(d.description.trim() ? { description: d.description.trim() } : {}),
      modules: [...new Set(['core', ...d.modules])],
      roleTemplates: d.roleTemplates.map((r) => ({ ...r, name: r.name.trim() })),
      defaultSettings: d.defaultSettings,
    };
    this.busy.set(true);
    this.error.set(null);
    try {
      if (d.id) await this.api.updateBusinessType(d.id, input);
      else await this.api.createBusinessType(input);
      this.toasts.success(`${input.name} saved`);
      this.open.set(false);
      this.types.reload();
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.error.set(err.code === 'CONFLICT' ? 'A business type with that key already exists.' : humanMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
