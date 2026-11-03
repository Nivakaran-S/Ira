import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { fieldErrors, humanMessage, toApiError, UiCopy, UiField } from 'ui';
import { ConsoleApi, type CreatedTenant } from './console-api';

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

/** Same origin scheme and port as the console, so links work in dev (:4200) and behind Caddy. */
export function tenantUrl(host: string, path = '/'): string {
  return `${location.protocol}//${host}${location.port ? `:${location.port}` : ''}${path}`;
}

@Component({
  selector: 'admin-tenant-new',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiField, UiCopy, RouterLink],
  template: `
    <div class="page stack">
      <a routerLink="/tenants" class="small">← Tenants</a>
      @if (created(); as c) {
        <section class="card stack" data-testid="tenant-created">
          <h1>{{ c.tenant.name }} is ready</h1>
          <p>Send the owner these details. <strong>The setup code is shown once</strong> and expires in 7 days.</p>
          <div class="stack">
            <div><div class="small muted">Back office</div><a [href]="tenantUrl(c.host)" target="_blank" rel="noopener" data-testid="tenant-host">{{ c.host }}</a></div>
            <div><div class="small muted">Owner</div>{{ c.owner.email }}</div>
            <div><div class="small muted">Owner setup code</div><ui-copy [value]="c.ownerSetupCode" data-testid="owner-setup-code" /></div>
            <div><div class="small muted">Setup link</div><ui-copy [value]="tenantUrl(c.host, '/setup-password?code=' + c.ownerSetupCode)" data-testid="owner-setup-link" /></div>
          </div>
          <div class="row">
            <a class="btn primary" [routerLink]="['/tenants', c.tenant.id]">Open tenant</a>
            <button class="btn" type="button" (click)="reset()">Create another</button>
          </div>
        </section>
      } @else {
        <section class="card stack">
          <h1>New tenant</h1>
          <form class="stack" (submit)="$event.preventDefault(); submit()">
            <div class="grid-2">
              <ui-field label="Business name" for="t-name" [error]="errors()['name']">
                <input id="t-name" required [value]="name()" (input)="onName(val($event))" />
              </ui-field>
              <ui-field label="Slug" for="t-slug" [hint]="slug() ? slug() + '.' + platformDomain : 'Lowercase letters, digits, hyphens'" [error]="errors()['slug']">
                <input id="t-slug" required [value]="slug()" (input)="slugTouched.set(true); slug.set(val($event))" />
              </ui-field>
            </div>
            <ui-field label="Business type" for="t-type" [error]="errors()['businessTypeId']">
              <select id="t-type" required [value]="businessTypeId()" (change)="businessTypeId.set(val($event))">
                <option value="" disabled>Choose…</option>
                @for (bt of businessTypes.value() ?? []; track bt.id) {
                  <option [value]="bt.id">{{ bt.name }}</option>
                }
              </select>
            </ui-field>
            <div class="grid-2">
              <ui-field label="Owner name" for="t-owner-name" [error]="errors()['ownerName']">
                <input id="t-owner-name" required [value]="ownerName()" (input)="ownerName.set(val($event))" />
              </ui-field>
              <ui-field label="Owner email" for="t-owner-email" [error]="errors()['ownerEmail']">
                <input id="t-owner-email" type="email" required [value]="ownerEmail()" (input)="ownerEmail.set(val($event))" />
              </ui-field>
            </div>
            <p class="small muted">Defaults: Sri Lanka, LKR, Asia/Colombo, standard plan.</p>
            @if (error()) {
              <div class="error-text" role="alert">{{ error() }}</div>
            }
            <div><button class="btn primary" type="submit" [disabled]="busy() || !valid()">Create tenant</button></div>
          </form>
        </section>
      }
    </div>
  `,
})
export class TenantNew {
  private readonly api = inject(ConsoleApi);
  protected readonly platformDomain = location.hostname.replace(/^admin\./, '');
  protected readonly tenantUrl = tenantUrl;
  protected readonly businessTypes = resource({ loader: () => this.api.listBusinessTypes() });

  protected readonly name = signal('');
  protected readonly slug = signal('');
  protected readonly slugTouched = signal(false);
  protected readonly businessTypeId = signal('');
  protected readonly ownerName = signal('');
  protected readonly ownerEmail = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly created = signal<CreatedTenant | null>(null);
  protected readonly valid = computed(() => !!(this.name().trim() && this.slug() && this.businessTypeId() && this.ownerName().trim() && this.ownerEmail().includes('@')));

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected onName(v: string) {
    this.name.set(v);
    if (!this.slugTouched()) this.slug.set(slugify(v));
  }

  protected async submit() {
    if (!this.valid() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.errors.set({});
    try {
      this.created.set(
        await this.api.createTenant({
          name: this.name().trim(),
          slug: this.slug().trim(),
          businessTypeId: this.businessTypeId(),
          ownerName: this.ownerName().trim(),
          ownerEmail: this.ownerEmail().trim(),
        }),
      );
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.error.set(err.code === 'CONFLICT' ? 'That slug is already taken.' : humanMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected reset() {
    this.created.set(null);
    for (const s of [this.name, this.slug, this.businessTypeId, this.ownerName, this.ownerEmail]) s.set('');
    this.slugTouched.set(false);
  }
}
