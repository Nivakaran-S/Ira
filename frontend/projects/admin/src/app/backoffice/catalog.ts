import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiResource, fieldErrors, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty, UiField } from 'ui';
import { CommerceApi, type Product } from './commerce-api';
import { type ProductWithCodes, RetailApi } from './retail-api';
import { BackofficeSession } from './session';
import { Money } from './money';

@Component({
  selector: 'admin-catalog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Catalog</h1>
        <button class="btn primary" type="button" data-testid="new-product" (click)="openNew()">New product</button>
      </div>

      <div class="layout">
        <section class="card flush">
          <div class="filter row">
            <input type="search" placeholder="Search products" aria-label="Search products" [value]="search()" (input)="search.set(val($event))" />
          </div>
          @if (filtered().length) {
            <table class="ui-table">
              <thead><tr><th>Name</th><th>SKU</th><th>Category</th><th>Tax</th><th class="num">Price</th><th></th></tr></thead>
              <tbody>
                @for (p of filtered(); track p.id) {
                  <tr [attr.data-product]="p.name">
                    <td>
                      @if (asRich(p).parentId) { <span class="muted">↳ </span> }
                      {{ p.name }} @if (!p.active) { <ui-badge tone="neutral">Inactive</ui-badge> }
                      @if (asRich(p).hasVariants) { <ui-badge tone="accent">Variants</ui-badge> }
                      @if (codes(p)) { <div class="small muted mono">{{ codes(p) }}</div> }
                    </td>
                    <td class="mono small">{{ p.sku ?? '—' }}</td>
                    <td class="small">{{ categoryName(p.categoryId) }}</td>
                    <td class="small">{{ groupName(p.taxGroupId) }}</td>
                    <td class="num">{{ money.fmt(p.price) }}</td>
                    <td class="row">
                      <button class="btn small" type="button" (click)="openEdit(p)">Edit</button>
                      @if (variantsOn() && !asRich(p).parentId) {
                        <button class="btn small" type="button" [attr.data-variants]="p.name" (click)="openVariants(p)">Variants</button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <ui-empty [title]="products.errorMessage() ?? (products.isLoading() ? 'Loading…' : 'No products yet')" />
          }
        </section>

        <section class="card stack">
          <h2>Categories</h2>
          @for (c of categories.value() ?? []; track c.id) {
            <div class="row"><span class="dot" [style.background]="c.color ?? '#c4cad3'"></span>{{ c.name }}</div>
          } @empty {
            <p class="muted small">None yet.</p>
          }
          <form class="row" (submit)="$event.preventDefault(); addCategory()">
            <input aria-label="New category" placeholder="New category" [value]="catName()" (input)="catName.set(val($event))" style="flex: 1" />
            <input type="color" aria-label="Colour" [value]="catColor()" (input)="catColor.set(val($event))" style="width: 48px; padding: 2px" />
            <button class="btn" type="submit" [disabled]="!catName().trim()">Add</button>
          </form>
        </section>
      </div>
    </div>

    <ui-dialog [title]="editingId() ? 'Edit product' : 'New product'" [open]="open()" (closed)="open.set(false)">
      <form class="stack" data-testid="product-form" (submit)="$event.preventDefault(); save()">
        <ui-field label="Name" for="p-name" [error]="errors()['name']"><input id="p-name" [value]="name()" (input)="name.set(val($event))" /></ui-field>
        <div class="grid-2">
          <ui-field label="Price" for="p-price" [hint]="'In ' + money.currency()" [error]="errors()['price']">
            <input id="p-price" inputmode="decimal" [value]="price()" (input)="price.set(val($event))" />
          </ui-field>
          <ui-field label="SKU (optional)" for="p-sku" [error]="errors()['sku']"><input id="p-sku" [value]="sku()" (input)="sku.set(val($event))" /></ui-field>
          <ui-field label="Category" for="p-cat">
            <select id="p-cat" [value]="categoryId()" (change)="categoryId.set(val($event))">
              <option value="">None</option>
              @for (c of categories.value() ?? []; track c.id) { <option [value]="c.id">{{ c.name }}</option> }
            </select>
          </ui-field>
          <ui-field label="Tax" for="p-tax" hint="Tax groups are set up under Taxes.">
            <select id="p-tax" [value]="taxGroupId()" (change)="taxGroupId.set(val($event))">
              <option value="">No tax</option>
              @for (g of groups.value() ?? []; track g.id) { <option [value]="g.id">{{ g.name }}</option> }
            </select>
          </ui-field>
        </div>
        @if (modifiersOn() && !familyEditing()) {
          <fieldset class="mods">
            <legend>Modifier groups</legend>
            @for (g of modGroups.value() ?? []; track g.id) {
              <label class="check"><input type="checkbox" [attr.data-mod-group]="g.name" [checked]="groupIds().includes(g.id)" (change)="toggleGroup(g.id, checked($event))" /> {{ g.name }}</label>
            } @empty { <span class="muted small">Create groups under Modifiers first.</span> }
          </fieldset>
        }
        @if (barcodesOn() && !familyEditing()) {
          <ui-field label="Barcodes" for="p-codes" hint="Separate several with commas." [error]="errors()['codes']">
            <input id="p-codes" [value]="barcodes()" (input)="barcodes.set(val($event))" />
          </ui-field>
        }
        @if (has('weighed-items')) {
          <div class="row">
            <label class="check"><input type="checkbox" data-testid="sold-by-weight" [checked]="soldByWeight()" (change)="soldByWeight.set(checked($event))" /> Sold by weight (price per kg)</label>
            <input aria-label="PLU" placeholder="Scale PLU" [value]="plu()" (input)="plu.set(val($event))" style="max-width: 120px" />
          </div>
        }
        @if (has('batch-expiry')) {
          <label class="check"><input type="checkbox" data-testid="tracks-batches" [checked]="tracksBatches()" (change)="tracksBatches.set(checked($event))" /> Track lots and expiry dates</label>
        }
        @if (has('prescriptions')) {
          <label class="check"><input type="checkbox" data-testid="rx-required" [checked]="rxRequired()" (change)="rxRequired.set(checked($event))" /> Prescription only</label>
        }
        <label class="check"><input type="checkbox" [checked]="trackStock()" (change)="trackStock.set(checked($event))" /> Track stock</label>
        <label class="check"><input type="checkbox" [checked]="active()" (change)="active.set(checked($event))" /> Sell on tills</label>
        <div><button class="btn primary" type="submit" [disabled]="busy() || !valid()">Save</button></div>
      </form>
    </ui-dialog>

    <ui-dialog [title]="'Variants of ' + (variantsFor()?.name ?? '')" [open]="!!variantsFor()" (closed)="variantsFor.set(null)">
      @if (variantsFor(); as fam) {
        <div class="stack" data-testid="variants-form">
          @for (v of variants.value() ?? []; track v.id) {
            <div class="row-between"><span>{{ v.variantLabel }}</span><span class="muted small">{{ v.sku ?? '' }} {{ money.fmt(v.price) }}</span></div>
          } @empty {
            <p class="muted">Each variant becomes its own product with its own price, stock and barcode. The family itself is no longer sold.</p>
          }
          <ui-field label="New variants" for="v-labels" hint="Comma separated, e.g. S, M, L">
            <input id="v-labels" [value]="newLabels()" (input)="newLabels.set(val($event))" />
          </ui-field>
          <ui-field label="Price (blank = family price)" for="v-price"><input id="v-price" inputmode="decimal" [value]="newPrice()" (input)="newPrice.set(val($event))" /></ui-field>
          <div><button class="btn primary" type="button" [disabled]="!newLabels().trim()" (click)="addVariants(fam)">Add variants</button></div>
        </div>
      }
    </ui-dialog>
  `,
  styles: `
    .layout { display: grid; grid-template-columns: 1fr 280px; gap: var(--s4); align-items: start; }
    .filter { padding: var(--s3); border-bottom: 1px solid var(--border); }
    .num { text-align: right; }
    .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
    .check { display: flex; gap: var(--s2); align-items: center; }
    .mods { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s3); display: grid; gap: 4px; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  `,
})
export class Catalog {
  private readonly api = inject(CommerceApi);
  private readonly retail = inject(RetailApi);
  private readonly session = inject(BackofficeSession);
  protected readonly variantsOn = computed(() => this.session.modules().includes('variants'));
  protected readonly barcodesOn = computed(() => this.session.modules().includes('barcodes'));
  protected readonly barcodes = signal('');
  protected readonly modifiersOn = computed(() => this.session.modules().includes('modifiers'));
  protected readonly modGroups = apiResource({
    params: () => (this.modifiersOn() ? true : undefined),
    loader: () => firstValueFrom(this.http.get<{ id: string; name: string }[]>('/api/modifier-groups')),
  });
  protected readonly groupIds = signal<string[]>([]);
  protected readonly soldByWeight = signal(false);
  protected readonly plu = signal('');
  protected readonly tracksBatches = signal(false);
  protected readonly rxRequired = signal(false);
  protected has(module: string) {
    return this.session.modules().includes(module);
  }
  private readonly http = inject(HttpClient);
  protected toggleGroup(id: string, on: boolean) {
    this.groupIds.update((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  }
  protected readonly familyEditing = signal(false);
  protected readonly variantsFor = signal<Product | null>(null);
  protected readonly variants = apiResource({ params: () => this.variantsFor()?.id, loader: ({ params }) => this.retail.variants(params) });
  protected readonly newLabels = signal('');
  protected readonly newPrice = signal('');
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);

  protected readonly products = apiResource({ loader: () => this.api.products() });
  protected readonly categories = apiResource({ loader: () => this.api.categories() });
  protected readonly groups = apiResource({ loader: () => this.api.taxGroups() });
  protected readonly search = signal('');
  protected readonly filtered = computed(() => {
    const q = this.search().trim().toLowerCase();
    return (this.products.value() ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q));
  });

  protected readonly open = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly price = signal('');
  protected readonly sku = signal('');
  protected readonly categoryId = signal('');
  protected readonly taxGroupId = signal('');
  protected readonly trackStock = signal(true);
  protected readonly active = signal(true);
  protected readonly busy = signal(false);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly valid = computed(() => !!this.name().trim() && this.money.parse(this.price()) !== null);

  protected readonly catName = signal('');
  protected readonly catColor = signal('#0f766e');

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected checked(e: Event) {
    return (e.target as HTMLInputElement).checked;
  }
  protected asRich(p: Product) {
    return p as ProductWithCodes;
  }
  protected codes(p: Product) {
    return (p as ProductWithCodes).barcodes?.map((b) => b.code).join(', ') ?? '';
  }

  protected openVariants(p: Product) {
    this.newLabels.set('');
    this.newPrice.set('');
    this.variantsFor.set(p);
  }

  protected async addVariants(fam: Product) {
    const price = this.newPrice().trim() ? this.money.parse(this.newPrice()) : undefined;
    if (price === null) return this.toasts.error('Enter the price as an amount.');
    const labels = this.newLabels().split(',').map((l) => l.trim()).filter(Boolean);
    try {
      await this.retail.addVariants(fam.id, labels.map((variantLabel) => ({ variantLabel, ...(price !== undefined ? { price } : {}) })));
      this.toasts.success(`${labels.length} variants added`);
      this.newLabels.set('');
      this.variants.reload();
      this.products.reload();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }

  protected categoryName(id: string | null) {
    return this.categories.value()?.find((c) => c.id === id)?.name ?? '—';
  }
  protected groupName(id: string | null) {
    return this.groups.value()?.find((g) => g.id === id)?.name ?? 'No tax';
  }

  protected openNew() {
    this.editingId.set(null);
    this.name.set('');
    this.price.set('');
    this.sku.set('');
    this.categoryId.set('');
    this.taxGroupId.set(this.groups.value()?.[0]?.id ?? '');
    this.trackStock.set(true);
    this.active.set(true);
    this.barcodes.set('');
    this.groupIds.set([]);
    this.soldByWeight.set(false);
    this.plu.set('');
    this.tracksBatches.set(false);
    this.rxRequired.set(false);
    this.familyEditing.set(false);
    this.errors.set({});
    this.open.set(true);
  }

  protected openEdit(p: Product) {
    this.editingId.set(p.id);
    this.name.set(p.name);
    this.price.set(this.money.fmt(p.price).replace(/,/g, ''));
    this.sku.set(p.sku ?? '');
    this.categoryId.set(p.categoryId ?? '');
    this.taxGroupId.set(p.taxGroupId ?? '');
    this.trackStock.set(p.trackStock);
    this.active.set(p.active);
    this.barcodes.set(this.codes(p));
    this.soldByWeight.set(!!p.soldByWeight);
    this.plu.set(p.plu ?? '');
    this.tracksBatches.set(!!p.tracksBatches);
    this.rxRequired.set(!!p.rxRequired);
    this.groupIds.set(((p as { modifierGroups?: { groupId: string }[] }).modifierGroups ?? []).map((g) => g.groupId));
    this.familyEditing.set(!!(p as ProductWithCodes).hasVariants);
    this.errors.set({});
    this.open.set(true);
  }

  protected async save() {
    this.busy.set(true);
    const input = {
      name: this.name().trim(),
      price: this.money.parse(this.price())!,
      ...(this.sku().trim() ? { sku: this.sku().trim() } : {}),
      categoryId: this.categoryId() || null,
      taxGroupId: this.taxGroupId() || null,
      trackStock: this.trackStock(),
      active: this.active(),
      ...(this.has('weighed-items') ? { soldByWeight: this.soldByWeight(), plu: this.plu().trim() || null } : {}),
      ...(this.has('batch-expiry') ? { tracksBatches: this.tracksBatches() } : {}),
      ...(this.has('prescriptions') ? { rxRequired: this.rxRequired() } : {}),
    };
    try {
      const id = this.editingId();
      const saved = id ? await this.api.updateProduct(id, input) : await this.api.createProduct(input);
      if (this.barcodesOn() && !this.familyEditing()) {
        const codes = this.barcodes().split(',').map((c) => c.trim()).filter(Boolean);
        if (codes.length || id) await this.retail.setBarcodes(saved.id, codes);
      }
      if (this.modifiersOn() && !this.familyEditing() && (this.groupIds().length || id)) {
        await firstValueFrom(this.http.put(`/api/products/${saved.id}/modifier-groups`, { groupIds: this.groupIds() }));
      }
      this.toasts.success(`${input.name} saved`);
      this.open.set(false);
      this.products.reload();
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.toasts.error(err.code === 'CONFLICT' ? 'Another product already uses that SKU.' : humanMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async addCategory() {
    try {
      await this.api.createCategory({ name: this.catName().trim(), color: this.catColor() });
      this.catName.set('');
      this.categories.reload();
    } catch (e) {
      const err = toApiError(e);
      this.toasts.error(err.code === 'CONFLICT' ? 'That category already exists.' : humanMessage(err));
    }
  }
}
