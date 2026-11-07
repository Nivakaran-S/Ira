import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty, UiField } from 'ui';
import { CommerceApi, type TaxGroup } from './commerce-api';
import { Money } from './money';

/** Tax rates and the ordered groups products point at. Sri Lanka: VAT 18% and SSCL 2.5%. */
@Component({
  selector: 'admin-taxes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <h1>Taxes</h1>
      <section class="card flush">
        @if (rates.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Rate</th><th>Percent</th><th>Compound</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (r of rates.value(); track r.id) {
                <tr>
                  <td>{{ r.name }}</td>
                  <td>{{ money.pct(r.rateBp) }}</td>
                  <td>{{ r.compound ? 'Yes' : 'No' }}</td>
                  <td><ui-badge [tone]="r.active ? 'ok' : 'neutral'">{{ r.active ? 'Active' : 'Off' }}</ui-badge></td>
                  <td><button class="btn small" type="button" (click)="toggle(r.id, !r.active)">{{ r.active ? 'Turn off' : 'Turn on' }}</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="rates.isLoading() ? 'Loading…' : 'No tax rates yet'" />
        }
      </section>
      <section class="card stack">
        <h2>Add a rate</h2>
        <form class="row" style="align-items: flex-end" (submit)="$event.preventDefault(); addRate()">
          <ui-field label="Name" for="t-name"><input id="t-name" [value]="rName()" (input)="rName.set(val($event))" placeholder="VAT" /></ui-field>
          <ui-field label="Percent" for="t-pct"><input id="t-pct" inputmode="decimal" [value]="rPct()" (input)="rPct.set(val($event))" placeholder="18" style="max-width: 120px" /></ui-field>
          <label class="check"><input type="checkbox" [checked]="rCompound()" (change)="rCompound.set(checked($event))" /> Compound (taxes earlier rates too)</label>
          <button class="btn primary" type="submit" [disabled]="!rateValid()">Add rate</button>
        </form>
      </section>

      <div class="row-between">
        <h2>Tax groups</h2>
        <button class="btn" type="button" (click)="editGroup(null)">New group</button>
      </div>
      <section class="card flush">
        <table class="ui-table">
          <thead><tr><th>Group</th><th>Rates, in order</th><th></th></tr></thead>
          <tbody>
            @for (g of groups.value() ?? []; track g.id) {
              <tr><td>{{ g.name }}</td><td>{{ describe(g) }}</td><td><button class="btn small" type="button" (click)="editGroup(g)">Edit</button></td></tr>
            } @empty {
              <tr><td colspan="3" class="muted">Products need a group to be taxed. Create one, e.g. "Standard" with VAT then SSCL.</td></tr>
            }
          </tbody>
        </table>
      </section>
    </div>

    <ui-dialog [title]="groupId() ? 'Edit tax group' : 'New tax group'" [open]="groupOpen()" (closed)="groupOpen.set(false)">
      <form class="stack" (submit)="$event.preventDefault(); saveGroup()">
        <ui-field label="Name" for="g-name"><input id="g-name" [value]="gName()" (input)="gName.set(val($event))" /></ui-field>
        <div class="stack">
          <strong>Rates (applied in this order)</strong>
          @for (id of gRates(); track id; let i = $index) {
            <div class="row">{{ i + 1 }}. {{ rateName(id) }}
              <button class="btn small" type="button" [disabled]="i === 0" (click)="move(i, -1)">↑</button>
              <button class="btn small" type="button" (click)="gRates.set(without(id))">Remove</button>
            </div>
          }
          <select aria-label="Add rate" (change)="addToGroup(val($event)); $any($event.target).value = ''">
            <option value="">Add a rate…</option>
            @for (r of rates.value() ?? []; track r.id) {
              @if (!gRates().includes(r.id)) { <option [value]="r.id">{{ r.name }} {{ money.pct(r.rateBp) }}</option> }
            }
          </select>
        </div>
        <div><button class="btn primary" type="submit" [disabled]="!gName().trim()">Save group</button></div>
      </form>
    </ui-dialog>
  `,
  styles: `.check { display: flex; gap: var(--s2); align-items: center; min-height: 40px; }`,
})
export class Taxes {
  private readonly api = inject(CommerceApi);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly rates = apiResource({ loader: () => this.api.taxRates() });
  protected readonly groups = apiResource({ loader: () => this.api.taxGroups() });

  protected readonly rName = signal('');
  protected readonly rPct = signal('');
  protected readonly rCompound = signal(false);
  protected readonly rateValid = computed(() => !!this.rName().trim() && this.bp() !== null);

  protected readonly groupOpen = signal(false);
  protected readonly groupId = signal<string | null>(null);
  protected readonly gName = signal('');
  protected readonly gRates = signal<string[]>([]);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected checked(e: Event) {
    return (e.target as HTMLInputElement).checked;
  }
  private bp() {
    const n = Number(this.rPct());
    return this.rPct().trim() && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
  }
  protected rateName(id: string) {
    const r = this.rates.value()?.find((x) => x.id === id);
    return r ? `${r.name} ${this.money.pct(r.rateBp)}${r.compound ? ' (compound)' : ''}` : id;
  }
  protected describe(g: TaxGroup) {
    return g.rateIds.map((id) => this.rateName(id)).join(' → ') || 'No rates';
  }
  protected without(id: string) {
    return this.gRates().filter((x) => x !== id);
  }

  private async attempt(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      this.toasts.success(ok);
      return true;
    } catch (e) {
      const err = toApiError(e);
      this.toasts.error(err.code === 'CONFLICT' ? 'That name is already used.' : humanMessage(err));
      return false;
    }
  }

  protected async addRate() {
    if (await this.attempt(() => this.api.createTaxRate({ name: this.rName().trim(), rateBp: this.bp()!, compound: this.rCompound(), active: true }), 'Rate added')) {
      this.rName.set('');
      this.rPct.set('');
      this.rCompound.set(false);
      this.rates.reload();
    }
  }

  protected async toggle(id: string, active: boolean) {
    if (await this.attempt(() => this.api.updateTaxRate(id, { active }), active ? 'Rate on' : 'Rate off')) this.rates.reload();
  }

  protected editGroup(g: TaxGroup | null) {
    this.groupId.set(g?.id ?? null);
    this.gName.set(g?.name ?? '');
    this.gRates.set(g ? [...g.rateIds] : []);
    this.groupOpen.set(true);
  }
  protected addToGroup(id: string) {
    if (id) this.gRates.update((r) => [...r, id]);
  }
  protected move(i: number, d: number) {
    this.gRates.update((r) => {
      const next = [...r];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });
  }
  protected async saveGroup() {
    if (await this.attempt(() => this.api.saveTaxGroup({ name: this.gName().trim(), rateIds: this.gRates() }, this.groupId() ?? undefined), 'Group saved')) {
      this.groupOpen.set(false);
      this.groups.reload();
    }
  }
}
