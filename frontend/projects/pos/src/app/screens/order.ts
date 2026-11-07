import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { priceWithPromotions, uuidv7 } from '@pos/shared';
import { apiResource, humanMessage, toApiError, ToastService, UiDialog } from 'ui';
import { ApprovalCancelled, Approvals } from '../api/approvals';
import { type CatalogProduct, type ChosenModifier, type Order, type OrderLine, PosApi } from '../api/pos-api';
import { HardwareBridge } from '../hardware/bridge';
import { TillState } from '../till-state';
import { ModifierPicker } from './modifier-picker';
import { type PaymentDraft, PaymentPanel } from './payment-panel';

const STATUS: Record<OrderLine['status'], string> = { NEW: 'Not sent', SENT: 'Sent', PREPARING: 'Preparing', READY: 'Ready', SERVED: 'Served', VOID: 'Void' };

/**
 * One table's order: add items, send them to the kitchen, and take payment for everything or for
 * the items one guest had (split by items). Prices come from the same engines as the sell screen.
 */
@Component({
  selector: 'pos-order',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiDialog, ModifierPicker, PaymentPanel],
  template: `
    @if (order.value(); as o) {
      <div class="split">
        <section class="products">
          <div class="row-between">
            <h1>{{ o.table?.name ?? o.name }}</h1>
            <button type="button" class="btn" (click)="back()">← Tables</button>
          </div>
          <input type="search" placeholder="Search" aria-label="Search products" [value]="query()" (input)="query.set(val($event))" />
          <div class="grid">
            @for (p of products(); track p.id) {
              <button type="button" class="tile" [attr.data-product]="p.name" (click)="add(p)" [disabled]="o.status !== 'OPEN'">
                <span>{{ p.name }}</span><span class="muted">{{ state.money(p.price) }}</span>
              </button>
            }
          </div>
        </section>
        <aside class="lines">
          @for (l of o.lines; track l.id) {
            <div class="line" [class.void]="l.status === 'VOID'" [attr.data-line]="l.name">
              @if (splitting()) {
                <label class="check"><input type="checkbox" [attr.data-split]="l.name" [disabled]="left(l) === 0 || l.status === 'VOID'" [checked]="!!selected()[l.id]" (change)="toggle(l)" /></label>
              }
              <div class="grow">
                <div class="row-between"><strong>{{ state.qty(l.qtyMilli) }} × {{ l.name }}</strong><span>{{ state.money(lineTotal(l)) }}</span></div>
                @if (l.modifiers.length) { <div class="small muted">{{ modText(l.modifiers) }}</div> }
                @if (l.note) { <div class="small muted">{{ l.note }}</div> }
                <div class="small">
                  <span class="status" [attr.data-status]="l.status">{{ statusText[l.status] }}</span>
                  @if (l.paidQtyMilli) { <span class="muted"> · {{ state.qty(l.paidQtyMilli) }} paid</span> }
                </div>
              </div>
              @if (l.status !== 'VOID' && !l.paidQtyMilli && o.status === 'OPEN') {
                <button type="button" class="btn small ghost" aria-label="Remove" (click)="remove(l)">×</button>
              }
            </div>
          } @empty {
            <p class="muted pad">Add items from the left.</p>
          }
          <div class="totals">
            <div class="row-between big"><span>{{ splitting() ? 'Selected' : 'Left to pay' }}</span><span data-testid="order-total">{{ state.money(payTotal()) }}</span></div>
          </div>
          @if (o.status === 'OPEN') {
            <div class="actions">
              <button type="button" class="btn" data-testid="send" [disabled]="!unsent()" (click)="send()">Send to kitchen ({{ unsent() }})</button>
              <button type="button" class="btn" data-testid="split" (click)="toggleSplit()">{{ splitting() ? 'Cancel split' : 'Split by items' }}</button>
              <button type="button" class="btn primary pay" data-testid="pay-order" [disabled]="payTotal() <= 0 || busy()" (click)="paying.set(true)">Pay {{ state.money(payTotal()) }}</button>
            </div>
          } @else {
            <p class="pad muted" data-testid="order-closed">This order is {{ o.status === 'CLOSED' ? 'paid' : 'cancelled' }}.</p>
          }
        </aside>
      </div>
    } @else {
      <p class="pad muted">{{ order.errorMessage() ?? 'Loading…' }}</p>
    }

    <ui-dialog [title]="modifying()?.name ?? ''" [open]="!!modifying()" (closed)="modifying.set(null)">
      @if (modifying(); as p) {
        <pos-modifier-picker [product]="p" (chosen)="addLine(p, $event); modifying.set(null)" />
      }
    </ui-dialog>

    <ui-dialog title="Payment" [open]="paying()" (closed)="paying.set(false)">
      @if (paying()) {
        <pos-payment-panel [busy]="busy()" [tips]="true" [total]="payTotal()" (complete)="pay($event.payments, $event.tip)" />
      }
    </ui-dialog>
  `,
  styles: `
    .split { display: grid; grid-template-columns: 1fr minmax(320px, 420px); height: 100%; }
    .products { padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); overflow: auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: var(--s2); }
    .tile { min-height: 80px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; padding: var(--s3); border-radius: var(--radius-lg); border: 1px solid var(--border); background: var(--surface); font: inherit; cursor: pointer; }
    .lines { border-left: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; overflow: auto; }
    .line { display: flex; gap: var(--s2); padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
    .line.void { opacity: 0.5; text-decoration: line-through; }
    .grow { flex: 1; }
    .status[data-status='READY'] { color: var(--ok); font-weight: 600; }
    .status[data-status='NEW'] { color: var(--warn); }
    .totals { padding: var(--s3) var(--s4); margin-top: auto; border-top: 1px solid var(--border); }
    .big { font-size: 20px; font-weight: 700; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s2); padding: var(--s3) var(--s4); }
    .pay { grid-column: 1 / -1; min-height: 52px; }
    .pad { padding: var(--s4); }
  `,
})
export class OrderScreen {
  protected readonly state = inject(TillState);
  private readonly api = inject(PosApi);
  private readonly approvals = inject(Approvals);
  private readonly bridge = inject(HardwareBridge);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  readonly id = input.required<string>();
  protected readonly statusText = STATUS;

  protected readonly order = apiResource({ params: () => this.id(), loader: ({ params }) => this.api.order(params) });
  protected readonly query = signal('');
  protected readonly modifying = signal<CatalogProduct | null>(null);
  protected readonly splitting = signal(false);
  protected readonly selected = signal<Record<string, number>>({});
  protected readonly paying = signal(false);
  protected readonly busy = signal(false);

  protected readonly products = computed(() => {
    const q = this.query().trim().toLowerCase();
    return (this.state.catalog()?.products ?? []).filter((p) => !p.hasVariants && (!q || p.name.toLowerCase().includes(q)));
  });
  protected readonly unsent = computed(() => (this.order.value()?.lines ?? []).filter((l) => l.status === 'NEW').length);

  /** What is being paid now: everything left, or the lines picked for this guest. */
  private readonly selection = computed(() => {
    const o = this.order.value();
    if (!o) return [];
    if (this.splitting()) return Object.entries(this.selected()).map(([orderLineId, qtyMilli]) => ({ orderLineId, qtyMilli }));
    return o.lines.filter((l) => l.status !== 'VOID' && this.left(l) > 0).map((l) => ({ orderLineId: l.id, qtyMilli: this.left(l) }));
  });

  /** Priced like the API will: catalog prices plus modifiers, promotions, tax. */
  private readonly priced = computed(() => {
    const o = this.order.value();
    const cat = this.state.catalog();
    if (!o || !cat) return null;
    const byId = new Map(cat.products.map((p) => [p.id, p]));
    const lines = this.selection().flatMap((sel, i) => {
      const l = o.lines.find((x) => x.id === sel.orderLineId);
      const p = l && byId.get(l.productId);
      if (!l || !p) return [];
      return [{
        key: String(i), productId: p.id, categoryId: p.categoryId, qtyMilli: sel.qtyMilli, taxes: p.taxes,
        unitPrice: p.price + l.modifiers.reduce((s, m) => s + m.priceDelta, 0),
      }];
    });
    return priceWithPromotions({ pricesIncludeTax: cat.settings.pricesIncludeTax, lines, promotions: cat.promotions ?? [], now: new Date() }).priced;
  });
  protected readonly payTotal = computed(() => this.priced()?.totals.total ?? 0);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected left(l: OrderLine) {
    return l.qtyMilli - l.paidQtyMilli;
  }
  protected lineTotal(l: OrderLine) {
    return Math.round((l.unitPrice * l.qtyMilli) / 1000);
  }
  protected modText(mods: ChosenModifier[]) {
    return mods.map((m) => m.name).join(', ');
  }
  protected back() {
    void this.router.navigateByUrl('/till/tables');
  }

  protected toggleSplit() {
    this.splitting.update((v) => !v);
    this.selected.set({});
  }
  protected toggle(l: OrderLine) {
    this.selected.update((s) => {
      const next = { ...s };
      if (next[l.id]) delete next[l.id];
      else next[l.id] = this.left(l);
      return next;
    });
  }

  private async attempt(fn: () => Promise<Order | unknown>) {
    this.busy.set(true);
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'lines' in r) this.order.set(r as Order);
      else this.order.reload();
    } catch (e) {
      if (!(e instanceof ApprovalCancelled)) this.toasts.error(humanMessage(toApiError(e)));
    } finally {
      this.busy.set(false);
    }
  }

  protected add(p: CatalogProduct) {
    if (p.modifierGroups?.length) this.modifying.set(p);
    else void this.addLine(p, []);
  }
  protected addLine(p: CatalogProduct, mods: ChosenModifier[]) {
    return this.attempt(() => this.api.addOrderLines(this.id(), [{ id: uuidv7(), productId: p.id, qtyMilli: 1000, modifierIds: mods.map((m) => m.id) }]));
  }
  protected remove(l: OrderLine) {
    return this.attempt(() => this.approvals.run((h) => this.api.removeOrderLine(this.id(), l.id, h)));
  }
  protected send() {
    return this.attempt(() => this.api.sendOrder(this.id()));
  }

  protected async pay(payments: PaymentDraft[], tip: number) {
    const allCash = payments.every((p) => p.method === 'CASH');
    const total = this.payTotal();
    const cashUnit = this.state.catalog()?.settings.cashRoundingUnit ?? 1;
    const expected = allCash ? Math.round(total / cashUnit) * cashUnit : total;
    const lines = this.selection();
    await this.attempt(async () => {
      const sale = await this.approvals.run((h) =>
        this.api.payOrder(this.id(), {
          saleId: uuidv7(), lines, tip, expectedTotal: expected,
          payments: payments.map((p) => ({ method: p.method, amount: p.amount, ...(p.tendered ? { tendered: p.tendered } : {}), ...(p.reference ? { reference: p.reference } : {}) })),
        }),
      );
      this.paying.set(false);
      this.splitting.set(false);
      this.selected.set({});
      this.toasts.success(`Paid ${this.state.money(sale.due + sale.tip)}${sale.change ? `, change ${this.state.money(sale.change)}` : ''}`);
      const receipt = await this.api.receipt(sale.id).catch(() => null);
      if (receipt) await this.bridge.print(receipt, payments.some((p) => p.method === 'CASH'));
      void this.state.refreshShift();
      return this.api.order(this.id());
    });
  }
}
