import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiCopy, UiDialog, UiEmpty, UiField } from 'ui';
import { ConsoleApi, type DomainView, type TenantDetail as Tenant, type TenantModules } from './console-api';
import { moduleRows } from './modules-view';
import { tenantUrl } from './tenant-new';

@Component({
  selector: 'admin-tenant-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, UiBadge, UiCopy, UiDialog, UiEmpty, UiField, DatePipe],
  template: `
    <div class="page stack">
      <a routerLink="/tenants" class="small">← Tenants</a>
      @if (tenant.value(); as t) {
        <div class="row-between">
          <div>
            <h1>{{ t.name }}</h1>
            <div class="row small muted">
              <a [href]="url(t.slug)" target="_blank" rel="noopener" class="mono">{{ t.slug }}.{{ platformDomain }}</a>
              <span>·</span><span>{{ t.country }} / {{ t.currency }} / {{ t.timezone }}</span>
              <span>·</span><span>Plan {{ t.plan.name }}</span>
            </div>
          </div>
          <div class="row">
            <ui-badge [tone]="t.status === 'ACTIVE' ? 'ok' : 'warn'" data-testid="tenant-status">{{ t.status === 'ACTIVE' ? 'Active' : 'Suspended' }}</ui-badge>
            @if (t.status === 'ACTIVE') {
              <button class="btn danger small" type="button" (click)="setStatus(t, 'SUSPENDED')">Suspend</button>
            } @else {
              <button class="btn small" type="button" (click)="setStatus(t, 'ACTIVE')">Reactivate</button>
            }
            <button class="btn small" type="button" (click)="impersonateOpen.set(true)">Impersonate…</button>
          </div>
        </div>

        <section class="card stack">
          <h2>Business type</h2>
          <div class="row">
            <select aria-label="Business type" [value]="t.businessTypeId" (change)="changeType(t, val($event))" style="max-width: 320px">
              @for (bt of businessTypes.value() ?? []; track bt.id) {
                <option [value]="bt.id">{{ bt.name }}</option>
              }
            </select>
            <span class="small muted">Changing it switches modules and adds missing template roles. No data is deleted.</span>
          </div>
          <div class="small muted">Limits: {{ t.plan.maxStores }} stores · {{ t.plan.maxDevices }} devices · {{ t.plan.maxUsers }} users</div>
        </section>

        <section class="card flush">
          <div class="pad"><h2>Modules</h2><p class="small muted">Overrides apply on top of the business type. Modules whose dependencies are off are dropped automatically.</p></div>
          <table class="ui-table">
            <thead><tr><th>Module</th><th>Business type</th><th>Override</th><th>Effective</th></tr></thead>
            <tbody>
              @for (m of rows(); track m.key) {
                <tr [attr.data-module]="m.key">
                  <td>{{ m.name }} @if (m.requires.length) { <span class="small muted">needs {{ m.requires.join(', ') }}</span> }</td>
                  <td>{{ m.inBase ? 'On' : '—' }}</td>
                  <td>
                    @if (m.locked) {
                      <span class="small muted">Always on</span>
                    } @else {
                      <select [attr.aria-label]="'Override for ' + m.name" [value]="m.override === null ? 'inherit' : m.override ? 'on' : 'off'" (change)="override(t.id, m.key, val($event))">
                        <option value="inherit">Follow type</option>
                        <option value="on">Force on</option>
                        <option value="off">Force off</option>
                      </select>
                    }
                  </td>
                  <td>
                    @if (m.resolved) {
                      <ui-badge tone="ok">On</ui-badge>
                    } @else if (m.droppedFor.length) {
                      <ui-badge tone="warn">Off — needs {{ m.droppedFor.join(', ') }}</ui-badge>
                    } @else {
                      <span class="muted">Off</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>

        <section class="card stack">
          <h2>Domains</h2>
          <p class="small muted">The tenant always has <span class="mono">{{ t.slug }}.{{ platformDomain }}</span>. A custom domain needs a DNS TXT record before it is served.</p>
          @for (d of domains.value() ?? []; track d.id) {
            <div class="domain stack">
              <div class="row-between">
                <strong class="mono">{{ d.hostname }}</strong>
                <div class="row">
                  @if (d.verifiedAt) {
                    <ui-badge tone="ok">Verified {{ d.verifiedAt | date: 'mediumDate' }}</ui-badge>
                  } @else {
                    <ui-badge tone="warn">Unverified</ui-badge>
                    <button class="btn small" type="button" (click)="verify(t.id, d)">Check DNS</button>
                  }
                  <button class="btn ghost small" type="button" (click)="removeDomain(t.id, d)">Remove</button>
                </div>
              </div>
              @if (!d.verifiedAt) {
                <div class="small">Add a TXT record: <ui-copy [value]="d.txtName" /> with value <ui-copy [value]="d.txtValue" /></div>
              }
            </div>
          } @empty {
            <ui-empty title="No custom domains" />
          }
          <form class="row" (submit)="$event.preventDefault(); addDomain(t.id)">
            <input aria-label="Custom domain" placeholder="shop.example.lk" [value]="newDomain()" (input)="newDomain.set(val($event))" style="max-width: 320px" />
            <button class="btn" type="submit" [disabled]="!newDomain().trim()">Add domain</button>
          </form>
        </section>

        <section class="card stack danger-zone">
          <h2>Delete tenant</h2>
          <p class="small">Soft delete: the tenant stops resolving immediately. Data is kept for 30 days.</p>
          <div class="row">
            <input aria-label="Type the slug to confirm" [placeholder]="t.slug" [value]="confirmSlug()" (input)="confirmSlug.set(val($event))" style="max-width: 240px" />
            <button class="btn danger" type="button" [disabled]="confirmSlug() !== t.slug" (click)="remove(t)">Delete</button>
          </div>
        </section>

        <ui-dialog title="Impersonate tenant owner" [open]="impersonateOpen()" (closed)="impersonateOpen.set(false)">
          <form class="stack" (submit)="$event.preventDefault(); impersonate(t)">
            <p class="small">Opens the back office as the owner for 30 minutes in a new tab. The reason is written to both audit logs.</p>
            <ui-field label="Reason" for="imp-reason" hint="At least 10 characters, e.g. the support ticket.">
              <textarea id="imp-reason" rows="3" [value]="reason()" (input)="reason.set(val($event))"></textarea>
            </ui-field>
            <div class="row"><button class="btn primary" type="submit" [disabled]="reason().trim().length < 10">Start impersonation</button></div>
          </form>
        </ui-dialog>
      } @else if (tenant.error()) {
        <ui-empty title="Tenant not found" />
      } @else {
        <ui-empty title="Loading…" />
      }
    </div>
  `,
  styles: `
    .pad { padding: var(--s5) var(--s5) 0; }
    .domain { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s3) var(--s4); }
    .danger-zone { border-color: #f4b8b2; }
  `,
})
export class TenantDetail {
  private readonly api = inject(ConsoleApi);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);

  /** Route param, bound by the router. */
  readonly id = input.required<string>();

  protected readonly platformDomain = location.hostname.replace(/^admin\./, '');
  protected readonly tenant = apiResource({ params: () => this.id(), loader: ({ params }) => this.api.getTenant(params) });
  protected readonly modules = apiResource({ params: () => this.id(), loader: ({ params }) => this.api.getModules(params) });
  protected readonly domains = apiResource({ params: () => this.id(), loader: ({ params }) => this.api.listDomains(params) });
  protected readonly businessTypes = apiResource({ loader: () => this.api.listBusinessTypes() });

  protected readonly rows = computed(() => {
    const m = this.modules.value();
    return m ? moduleRows(m.base, m.overrides, m.resolved) : [];
  });
  protected readonly newDomain = signal('');
  protected readonly confirmSlug = signal('');
  protected readonly impersonateOpen = signal(false);
  protected readonly reason = signal('');

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected url(slug: string) {
    return tenantUrl(`${slug}.${this.platformDomain}`);
  }

  private async run<T>(work: () => Promise<T>, ok?: string): Promise<T | undefined> {
    try {
      const r = await work();
      if (ok) this.toasts.success(ok);
      return r;
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
      return undefined;
    }
  }

  protected async setStatus(t: Tenant, status: 'ACTIVE' | 'SUSPENDED') {
    const r = await this.run(() => this.api.setStatus(t.id, status), status === 'ACTIVE' ? 'Tenant reactivated' : 'Tenant suspended');
    if (r) this.tenant.set(r);
  }

  protected async changeType(t: Tenant, businessTypeId: string) {
    if (businessTypeId === t.businessTypeId) return;
    const r = await this.run(() => this.api.changeBusinessType(t.id, businessTypeId), 'Business type changed');
    if (r) this.tenant.set(r);
    this.modules.reload();
  }

  protected async override(id: string, key: string, choice: string) {
    const work = (): Promise<TenantModules> => (choice === 'inherit' ? this.api.clearModule(id, key) : this.api.setModule(id, key, choice === 'on'));
    const r = await this.run(work, 'Modules updated');
    if (r) this.modules.set(r);
    else this.modules.reload();
  }

  protected async addDomain(id: string) {
    const r = await this.run(() => this.api.addDomain(id, this.newDomain().trim()), 'Domain added');
    if (r) {
      this.newDomain.set('');
      this.domains.reload();
    }
  }

  protected async verify(id: string, d: DomainView) {
    const r = await this.run(() => this.api.verifyDomain(id, d.id));
    if (!r) return;
    if (r.verified) this.toasts.success(`${d.hostname} verified`);
    else this.toasts.error(`TXT record not found yet for ${d.hostname}. DNS can take a while to propagate.`);
    this.domains.reload();
  }

  protected async removeDomain(id: string, d: DomainView) {
    await this.run(() => this.api.removeDomain(id, d.id), 'Domain removed');
    this.domains.reload();
  }

  protected async impersonate(t: Tenant) {
    const r = await this.run(() => this.api.impersonate(t.id, this.reason().trim()));
    if (!r) return;
    this.impersonateOpen.set(false);
    this.reason.set('');
    window.open(tenantUrl(r.host, `/#imp=${encodeURIComponent(r.accessToken)}`), '_blank', 'noopener');
    this.toasts.info('Impersonation opened in a new tab. It ends in 30 minutes.');
  }

  protected async remove(t: Tenant) {
    const ok = await this.run(async () => {
      await this.api.deleteTenant(t.id);
      return true;
    }, `${t.name} deleted`);
    if (ok) await this.router.navigateByUrl('/tenants');
  }
}
