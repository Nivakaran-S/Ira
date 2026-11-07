import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty, UiField } from 'ui';
import { BackofficeApi } from './backoffice-api';
import { CommerceApi } from './commerce-api';
import { Money } from './money';

interface Supplier {
  id: string;
  name: string;
  phone: string | null;
}
interface PoLine {
  id: string;
  productId: string;
  qtyMilli: number;
  receivedQtyMilli: number;
  unitCost: number;
}
interface Po {
  id: string;
  number: string;
  status: 'DRAFT' | 'ORDERED' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED';
  storeId: string;
  createdAt: string;
  supplier: { name: string };
  lines: PoLine[];
}
interface Draft {
  productId: string;
  qty: string;
  cost: string;
}
interface Receipt {
  qty: string;
  lotNo: string;
  expiresOn: string;
}

/** Suppliers and purchase orders: draft, send, receive in parts (into lots where needed). */
@Component({
  selector: 'admin-purchasing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, UiBadge, UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Purchasing</h1>
        <button class="btn primary" type="button" data-testid="new-po" [disabled]="!(suppliers.value()?.length)" (click)="newPo()">New purchase order</button>
      </div>
      <section class="card flush">
        @if (orders.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Order</th><th>Supplier</th><th>Created</th><th class="num">Value</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (o of orders.value(); track o.id) {
                <tr [attr.data-po]="o.number">
                  <td class="mono">{{ o.number }}</td>
                  <td>{{ o.supplier.name }}</td>
                  <td class="small">{{ o.createdAt | date: 'mediumDate' }}</td>
                  <td class="num">{{ money.fmt(value(o)) }}</td>
                  <td><ui-badge [tone]="o.status === 'RECEIVED' ? 'ok' : o.status === 'CANCELLED' ? 'neutral' : 'warn'">{{ o.status }}</ui-badge></td>
                  <td><button class="btn small" type="button" (click)="open(o)">Open</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="orders.errorMessage() ?? (orders.isLoading() ? 'Loading…' : 'No purchase orders yet')" />
        }
      </section>
      <section class="card stack">
        <h2>Suppliers</h2>
        @for (s of suppliers.value() ?? []; track s.id) { <div class="row-between"><span>{{ s.name }}</span><span class="muted small">{{ s.phone ?? '' }}</span></div> }
        <form class="row" (submit)="$event.preventDefault(); addSupplier()">
          <input aria-label="Supplier name" placeholder="Supplier name" [value]="supName()" (input)="supName.set(val($event))" style="flex: 1" />
          <input aria-label="Supplier phone" placeholder="Phone" [value]="supPhone()" (input)="supPhone.set(val($event))" style="max-width: 180px" />
          <button class="btn" type="submit" [disabled]="!supName().trim()">Add supplier</button>
        </form>
      </section>
    </div>

    <ui-dialog title="New purchase order" [open]="creating()" (closed)="creating.set(false)">
      <form class="stack" data-testid="po-form" (submit)="$event.preventDefault(); create()">
        <div class="grid-2">
          <ui-field label="Supplier" for="po-sup">
            <select id="po-sup" [value]="supplierId()" (change)="supplierId.set(val($event))">
              @for (s of suppliers.value() ?? []; track s.id) { <option [value]="s.id">{{ s.name }}</option> }
            </select>
          </ui-field>
          <ui-field label="Deliver to" for="po-store">
            <select id="po-store" [value]="storeId()" (change)="storeId.set(val($event))">
              @for (s of stores.value() ?? []; track s.id) { <option [value]="s.id">{{ s.code }} · {{ s.name }}</option> }
            </select>
          </ui-field>
        </div>
        @for (l of draft(); track $index; let i = $index) {
          <div class="row">
            <select [attr.aria-label]="'Product ' + (i + 1)" [value]="l.productId" (change)="setLine(i, { productId: val($event) })" style="flex: 2">
              <option value="">Product…</option>
              @for (p of products(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
            </select>
            <input [attr.aria-label]="'Quantity ' + (i + 1)" placeholder="Qty" inputmode="decimal" [value]="l.qty" (input)="setLine(i, { qty: val($event) })" style="max-width: 90px" />
            <input [attr.aria-label]="'Unit cost ' + (i + 1)" placeholder="Unit cost" inputmode="decimal" [value]="l.cost" (input)="setLine(i, { cost: val($event) })" style="max-width: 120px" />
          </div>
        }
        <div><button class="btn small" type="button" (click)="draft.update((d) => [...d, { productId: '', qty: '', cost: '' }])">+ Line</button></div>
        <div><button class="btn primary" type="submit">Create order</button></div>
      </form>
    </ui-dialog>

    <ui-dialog [title]="'Order ' + (current()?.number ?? '')" [open]="!!current()" (closed)="current.set(null)">
      @if (current(); as o) {
        <div class="stack" data-testid="po-detail">
          @for (l of o.lines; track l.id) {
            <div class="row" [attr.data-po-line]="productName(l.productId)">
              <span class="grow">{{ productName(l.productId) }} · {{ money.qty(l.receivedQtyMilli) }} of {{ money.qty(l.qtyMilli) }} received · {{ money.fmt(l.unitCost) }} each</span>
              @if ((o.status === 'ORDERED' || o.status === 'PARTIAL') && l.receivedQtyMilli < l.qtyMilli) {
                <input [attr.aria-label]="'Receive ' + productName(l.productId)" placeholder="Qty" inputmode="decimal" [value]="rec()[l.id]?.qty ?? ''" (input)="setRec(l.id, { qty: val($event) })" style="max-width: 80px" />
                @if (tracksLots(l.productId)) {
                  <input [attr.aria-label]="'Lot ' + productName(l.productId)" placeholder="Lot" [value]="rec()[l.id]?.lotNo ?? ''" (input)="setRec(l.id, { lotNo: val($event) })" style="max-width: 90px" />
                  <input [attr.aria-label]="'Expiry ' + productName(l.productId)" type="date" [value]="rec()[l.id]?.expiresOn ?? ''" (input)="setRec(l.id, { expiresOn: val($event) })" style="max-width: 150px" />
                }
              }
            </div>
          }
          <div class="row-between">
            @if (o.status === 'DRAFT') { <button class="btn primary" type="button" data-testid="po-send" (click)="act(o, 'order')">Send to supplier</button> }
            @if (o.status === 'ORDERED' || o.status === 'PARTIAL') { <button class="btn primary" type="button" data-testid="po-receive" (click)="receive(o)">Receive goods</button> }
            @if (o.status === 'DRAFT' || o.status === 'ORDERED') { <button class="btn" type="button" (click)="act(o, 'cancel')">Cancel order</button> }
          </div>
        </div>
      }
    </ui-dialog>
  `,
  styles: `.num { text-align: right; } .grow { flex: 1; }`,
})
export class Purchasing {
  private readonly http = inject(HttpClient);
  private readonly bo = inject(BackofficeApi);
  private readonly commerce = inject(CommerceApi);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly orders = apiResource({ loader: () => firstValueFrom(this.http.get<Po[]>('/api/purchase-orders')) });
  protected readonly suppliers = apiResource({ loader: () => firstValueFrom(this.http.get<Supplier[]>('/api/suppliers')) });
  protected readonly stores = apiResource({ loader: () => this.bo.stores() });
  private readonly allProducts = apiResource({ loader: () => this.commerce.products(false) });
  protected readonly products = computed(() => (this.allProducts.value() ?? []).filter((p) => !(p as { hasVariants?: boolean }).hasVariants));
  protected readonly supName = signal('');
  protected readonly supPhone = signal('');
  protected readonly creating = signal(false);
  protected readonly supplierId = signal('');
  protected readonly storeId = signal('');
  protected readonly draft = signal<Draft[]>([]);
  protected readonly current = signal<Po | null>(null);
  protected readonly rec = signal<Record<string, Receipt>>({});

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected productName(id: string) {
    return this.allProducts.value()?.find((p) => p.id === id)?.name ?? '';
  }
  protected tracksLots(id: string) {
    return !!(this.allProducts.value()?.find((p) => p.id === id) as { tracksBatches?: boolean } | undefined)?.tracksBatches;
  }
  protected value(o: Po) {
    return o.lines.reduce((s, l) => s + Math.round((l.unitCost * l.qtyMilli) / 1000), 0);
  }
  protected setLine(i: number, patch: Partial<Draft>) {
    this.draft.update((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }
  protected setRec(id: string, patch: Partial<Receipt>) {
    this.rec.update((r) => ({ ...r, [id]: { ...(r[id] ?? { qty: '', lotNo: '', expiresOn: '' }), ...patch } }));
  }

  private async attempt(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      this.toasts.success(ok);
      return true;
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
      return false;
    }
  }

  protected async addSupplier() {
    if (await this.attempt(() => firstValueFrom(this.http.post('/api/suppliers', { name: this.supName().trim(), ...(this.supPhone().trim() ? { phone: this.supPhone().trim() } : {}) })), 'Supplier added')) {
      this.supName.set('');
      this.supPhone.set('');
      this.suppliers.reload();
    }
  }

  protected newPo() {
    this.supplierId.set(this.suppliers.value()?.[0]?.id ?? '');
    this.storeId.set(this.stores.value()?.[0]?.id ?? '');
    this.draft.set([{ productId: '', qty: '', cost: '' }]);
    this.creating.set(true);
  }

  protected async create() {
    const lines = this.draft()
      .filter((l) => l.productId && +l.qty > 0)
      .map((l) => ({ productId: l.productId, qtyMilli: Math.round(+l.qty * 1000), unitCost: this.money.parse(l.cost) ?? 0 }));
    if (!lines.length) return this.toasts.error('Add at least one line.');
    if (await this.attempt(() => firstValueFrom(this.http.post('/api/purchase-orders', { supplierId: this.supplierId(), storeId: this.storeId(), lines })), 'Purchase order created')) {
      this.creating.set(false);
      this.orders.reload();
    }
  }

  protected async open(o: Po) {
    this.rec.set({});
    this.current.set(o);
  }

  protected async act(o: Po, what: 'order' | 'cancel') {
    if (await this.attempt(() => firstValueFrom(this.http.post(`/api/purchase-orders/${o.id}/${what}`, {})), what === 'order' ? 'Sent to supplier' : 'Cancelled')) {
      this.current.set(await firstValueFrom(this.http.get<Po>(`/api/purchase-orders/${o.id}`)));
      this.orders.reload();
    }
  }

  protected async receive(o: Po) {
    const lines = Object.entries(this.rec())
      .filter(([, r]) => +r.qty > 0)
      .map(([lineId, r]) => ({ lineId, qtyMilli: Math.round(+r.qty * 1000), ...(r.lotNo.trim() ? { lotNo: r.lotNo.trim() } : {}), ...(r.expiresOn ? { expiresOn: r.expiresOn } : {}) }));
    if (!lines.length) return this.toasts.error('Enter what arrived.');
    if (await this.attempt(() => firstValueFrom(this.http.post(`/api/purchase-orders/${o.id}/receive`, { lines })), 'Goods received')) {
      this.rec.set({});
      this.current.set(await firstValueFrom(this.http.get<Po>(`/api/purchase-orders/${o.id}`)));
      this.orders.reload();
    }
  }
}
