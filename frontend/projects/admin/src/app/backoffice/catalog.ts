import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { apiResource, fieldErrors, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty, UiField } from 'ui';
import { CommerceApi, type Product } from './commerce-api';
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
                    <td>{{ p.name }} @if (!p.active) { <ui-badge tone="neutral">Inactive</ui-badge> }</td>
                    <td class="mono small">{{ p.sku ?? '—' }}</td>
                    <td class="small">{{ categoryName(p.categoryId) }}</td>
                    <td class="small">{{ groupName(p.taxGroupId) }}</td>
                    <td class="num">{{ money.fmt(p.price) }}</td>
                    <td><button class="btn small" type="button" (click)="openEdit(p)">Edit</button></td>
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
        <label class="check"><input type="checkbox" [checked]="trackStock()" (change)="trackStock.set(checked($event))" /> Track stock</label>
        <label class="check"><input type="checkbox" [checked]="active()" (change)="active.set(checked($event))" /> Sell on tills</label>
        <div><button class="btn primary" type="submit" [disabled]="busy() || !valid()">Save</button></div>
      </form>
    </ui-dialog>
  `,
  styles: `
    .layout { display: grid; grid-template-columns: 1fr 280px; gap: var(--s4); align-items: start; }
    .filter { padding: var(--s3); border-bottom: 1px solid var(--border); }
    .num { text-align: right; }
    .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
    .check { display: flex; gap: var(--s2); align-items: center; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  `,
})
export class Catalog {
  private readonly api = inject(CommerceApi);
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
    };
    try {
      const id = this.editingId();
      if (id) await this.api.updateProduct(id, input);
      else await this.api.createProduct(input);
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
