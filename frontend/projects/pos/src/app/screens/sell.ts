import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { type Discount, type ReceiptDoc, uuidv7 } from '@pos/shared';
import { humanMessage, toApiError, ToastService, UiDialog } from 'ui';
import { ApprovalCancelled, Approvals } from '../api/approvals';
import { type CatalogProduct, PosApi, type Sale } from '../api/pos-api';
import { HardwareBridge } from '../hardware/bridge';
import { Cart, type CartLine } from '../sell/cart';
import { TillState } from '../till-state';
import { OpenShift } from './open-shift';
import { PaymentPanel, type PaymentDraft } from './payment-panel';
import { ReceiptView } from './receipt-view';

@Component({
  selector: 'pos-sell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiDialog, OpenShift, PaymentPanel, ReceiptView],
  template: `
    @if (!state.loaded()) {
      <p class="muted pad">Loading the till…</p>
    } @else if (!state.shiftOpen()) {
      <pos-open-shift />
    } @else {
      <div class="sell">
        <section class="products">
          <div class="row search">
            <input type="search" placeholder="Search name or SKU" aria-label="Search products" data-testid="search" [value]="query()" (input)="query.set(val($event))" (keydown.enter)="addFirst()" />
          </div>
          <div class="chips">
            <button type="button" class="chip" [class.on]="category() === null" (click)="category.set(null)">All</button>
            @for (c of state.catalog()?.categories ?? []; track c.id) {
              <button type="button" class="chip" [class.on]="category() === c.id" [style.border-color]="c.color ?? null" (click)="category.set(c.id)">{{ c.name }}</button>
            }
          </div>
          <div class="grid">
            @for (p of visible(); track p.id) {
              <button type="button" class="tile" [attr.data-product]="p.name" (click)="add(p)">
                <span class="name">{{ p.name }}</span>
                <span class="price">{{ state.money(p.price) }}</span>
              </button>
            } @empty {
              <p class="muted">No products match. Products are added in the back office under Catalog.</p>
            }
          </div>
        </section>

        <aside class="cart">
          <div class="lines" data-testid="cart">
            @for (l of cart.lines(); track l.key) {
              <button type="button" class="line" [class.sel]="editing()?.key === l.key" (click)="edit(l)">
                <div class="l1"><span>{{ l.product.name }}</span><span>{{ state.money(cart.pricedLine(l.key)?.net ?? 0) }}</span></div>
                <div class="l2 muted small">
                  {{ state.qty(l.qtyMilli) }} × {{ state.money(l.unitPrice ?? l.product.price) }}
                  @if (l.unitPrice !== undefined) { <span class="tag">price changed</span> }
                  @if (cart.pricedLine(l.key)?.discount) { <span class="tag">−{{ state.money(cart.pricedLine(l.key)!.discount) }}</span> }
                </div>
              </button>
            } @empty {
              <p class="muted empty">Tap a product to start a sale.</p>
            }
          </div>
          <div class="totals">
            <div class="r"><span>Subtotal</span><span>{{ state.money(cart.priced().totals.subtotal) }}</span></div>
            @if (cart.priced().totals.discountTotal) {
              <div class="r"><span>Discounts</span><span>−{{ state.money(cart.priced().totals.discountTotal) }}</span></div>
            }
            <div class="r small muted"><span>Tax{{ cart.settings()?.pricesIncludeTax ? ' (included)' : '' }}</span><span>{{ state.money(cart.priced().totals.taxTotal) }}</span></div>
            <div class="r big"><span>Total</span><span data-testid="cart-total">{{ state.money(cart.total()) }}</span></div>
          </div>
          <div class="actions">
            <button type="button" class="btn" [disabled]="cart.empty()" (click)="cartDiscountOpen.set(true)">Discount</button>
            <button type="button" class="btn" [disabled]="cart.empty()" (click)="cart.clear()">Clear</button>
            <button type="button" class="btn primary pay" data-testid="pay" [disabled]="cart.empty() || busy()" (click)="paying.set(true)">Pay {{ state.money(cart.total()) }}</button>
          </div>
        </aside>
      </div>
    }

    <ui-dialog [title]="editing()?.product?.name ?? ''" [open]="!!editing()" (closed)="editing.set(null)">
      @if (editing(); as l) {
        <div class="stack">
          <div class="row qty">
            <button type="button" class="btn big-btn" aria-label="One less" (click)="bump(l, -1000)">−</button>
            <input aria-label="Quantity" inputmode="decimal" [value]="state.qty(l.qtyMilli)" (change)="setQty(l, val($event))" />
            <button type="button" class="btn big-btn" aria-label="One more" (click)="bump(l, 1000)">+</button>
          </div>
          <div class="row">
            <label class="grow">Discount %<input inputmode="decimal" [value]="pctOf(l.discount)" (change)="setLineDiscount(l, val($event))" /></label>
            <label class="grow">Price<input inputmode="decimal" [value]="state.money(l.unitPrice ?? l.product.price)" (change)="setPrice(l, val($event))" /></label>
          </div>
          <label>Note<input [value]="l.note ?? ''" (change)="cart.update(l.key, { note: val($event) || undefined })" /></label>
          <div class="row-between">
            <button type="button" class="btn danger" (click)="cart.remove(l.key); editing.set(null)">Remove</button>
            <button type="button" class="btn primary" (click)="editing.set(null)">Done</button>
          </div>
        </div>
      }
    </ui-dialog>

    <ui-dialog title="Discount on the sale" [open]="cartDiscountOpen()" (closed)="cartDiscountOpen.set(false)">
      <div class="stack">
        <div class="row">
          @for (p of [5, 10, 15, 20]; track p) {
            <button type="button" class="btn" (click)="setCartDiscount({ kind: 'percent', bp: p * 100 })">{{ p }}%</button>
          }
        </div>
        <label>Amount off<input inputmode="decimal" #amt /></label>
        <div class="row-between">
          <button type="button" class="btn" (click)="setCartDiscount(null)">No discount</button>
          <button type="button" class="btn primary" (click)="setCartAmount(amt.value)">Apply amount</button>
        </div>
      </div>
    </ui-dialog>

    <ui-dialog title="Payment" [open]="paying()" (closed)="paying.set(false)">
      @if (paying()) {
        <pos-payment-panel [busy]="busy()" (complete)="complete($event)" />
      }
    </ui-dialog>

    <ui-dialog title="Sale complete" [open]="!!done()" (closed)="done.set(null)">
      @if (done(); as d) {
        <div class="stack" data-testid="sale-complete">
          @if (d.sale.change) {
            <div class="change">Change <strong data-testid="change">{{ state.money(d.sale.change) }}</strong></div>
          }
          <div class="muted">Receipt {{ d.sale.receiptNo }}</div>
          @if (d.receipt) {
            <pos-receipt-view [receipt]="d.receipt" />
          }
          <div class="row-between">
            <button type="button" class="btn" (click)="print(d.receipt)">Print again</button>
            <button type="button" class="btn primary" data-testid="new-sale" (click)="done.set(null)">New sale</button>
          </div>
        </div>
      }
    </ui-dialog>
  `,
  styles: `
    .pad { padding: var(--s5); }
    .sell { display: grid; grid-template-columns: 1fr minmax(320px, 400px); height: 100%; }
    .products { padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); min-height: 0; overflow: auto; }
    .search input { font-size: 17px; }
    .chips { display: flex; gap: var(--s2); flex-wrap: wrap; }
    .chip { padding: var(--s2) var(--s4); border-radius: 999px; border: 2px solid var(--border); background: var(--surface); font: inherit; font-weight: 600; cursor: pointer; }
    .chip.on { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--s3); }
    .tile { min-height: 96px; display: flex; flex-direction: column; justify-content: space-between; align-items: flex-start; padding: var(--s3); border-radius: var(--radius-lg); border: 1px solid var(--border); background: var(--surface); box-shadow: var(--shadow); font: inherit; text-align: left; cursor: pointer; touch-action: manipulation; }
    .tile:active { background: var(--surface-2); }
    .tile .name { font-weight: 600; }
    .tile .price { color: var(--text-2); }
    .cart { border-left: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; min-height: 0; }
    .lines { flex: 1; overflow: auto; }
    .line { display: block; width: 100%; text-align: left; padding: var(--s3) var(--s4); border: none; border-bottom: 1px solid var(--border); background: none; font: inherit; cursor: pointer; }
    .line.sel { background: var(--accent-soft); }
    .l1 { display: flex; justify-content: space-between; font-weight: 600; }
    .tag { background: var(--warn-soft); color: var(--warn); padding: 0 6px; border-radius: 6px; margin-left: 4px; }
    .empty { padding: var(--s5); text-align: center; }
    .totals { padding: var(--s3) var(--s4); border-top: 1px solid var(--border); }
    .r { display: flex; justify-content: space-between; }
    .big { font-size: 22px; font-weight: 700; margin-top: var(--s2); }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s2); padding: var(--s3) var(--s4); }
    .pay { grid-column: 1 / -1; min-height: 56px; font-size: 18px; }
    .qty { justify-content: center; }
    .qty input { max-width: 120px; text-align: center; font-size: 20px; }
    .big-btn { min-width: 56px; min-height: 56px; font-size: 24px; }
    .grow { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    label { display: flex; flex-direction: column; gap: 4px; font-weight: 550; }
    .change { font-size: 26px; text-align: center; background: var(--ok-soft); color: var(--ok); border-radius: var(--radius-lg); padding: var(--s4); }
    .btn.danger { color: var(--danger); }
    @media (max-width: 820px) { .sell { grid-template-columns: 1fr; } .cart { border-left: none; border-top: 1px solid var(--border); } }
  `,
})
export class Sell {
  protected readonly state = inject(TillState);
  protected readonly cart = inject(Cart);
  private readonly api = inject(PosApi);
  private readonly approvals = inject(Approvals);
  private readonly bridge = inject(HardwareBridge);
  private readonly toasts = inject(ToastService);

  protected readonly query = signal('');
  protected readonly category = signal<string | null>(null);
  protected readonly editing = signal<CartLine | null>(null);
  protected readonly cartDiscountOpen = signal(false);
  protected readonly paying = signal(false);
  protected readonly busy = signal(false);
  protected readonly done = signal<{ sale: Sale; receipt: ReceiptDoc | null } | null>(null);

  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const cat = this.category();
    return (this.state.catalog()?.products ?? []).filter(
      (p) => (!cat || p.categoryId === cat) && (!q || p.name.toLowerCase().includes(q) || p.sku?.toLowerCase() === q),
    );
  });

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected add(p: CatalogProduct) {
    this.cart.add(p);
  }

  protected addFirst() {
    const first = this.visible()[0];
    if (first) {
      this.add(first);
      this.query.set('');
    }
  }

  protected edit(l: CartLine) {
    this.editing.set(l);
  }

  private refreshEditing(key: string) {
    this.editing.set(this.cart.lines().find((x) => x.key === key) ?? null);
  }

  protected bump(l: CartLine, delta: number) {
    const cur = this.cart.lines().find((x) => x.key === l.key);
    if (!cur) return;
    this.cart.setQty(l.key, cur.qtyMilli + delta);
    this.refreshEditing(l.key);
  }

  protected setQty(l: CartLine, text: string) {
    const n = Number(text);
    if (Number.isFinite(n) && n >= 0) this.cart.setQty(l.key, Math.round(n * 1000));
    this.refreshEditing(l.key);
  }

  protected pctOf(d: Discount | undefined) {
    return d?.kind === 'percent' ? String(d.bp / 100) : '';
  }

  protected setLineDiscount(l: CartLine, text: string) {
    const n = Number(text);
    this.cart.update(l.key, { discount: text.trim() && n > 0 && n <= 100 ? { kind: 'percent', bp: Math.round(n * 100) } : undefined });
    this.refreshEditing(l.key);
  }

  protected setPrice(l: CartLine, text: string) {
    const v = this.state.parse(text);
    if (v === null) return;
    this.cart.update(l.key, { unitPrice: v === l.product.price ? undefined : v });
    this.refreshEditing(l.key);
  }

  protected setCartDiscount(d: Discount | null) {
    this.cart.cartDiscount.set(d);
    this.cartDiscountOpen.set(false);
  }

  protected setCartAmount(text: string) {
    const v = this.state.parse(text);
    if (v && v > 0) this.setCartDiscount({ kind: 'amount', amount: v });
  }

  protected async complete(payments: PaymentDraft[]) {
    if (this.busy()) return;
    this.busy.set(true);
    const allCash = payments.every((p) => p.method === 'CASH');
    const body = {
      id: uuidv7(),
      lines: this.cart.lines().map((l) => ({
        productId: l.product.id,
        qtyMilli: l.qtyMilli,
        ...(l.unitPrice !== undefined ? { unitPrice: l.unitPrice } : {}),
        ...(l.discount ? { discount: l.discount } : {}),
        ...(l.note ? { note: l.note } : {}),
      })),
      ...(this.cart.cartDiscount() ? { cartDiscount: this.cart.cartDiscount()! } : {}),
      payments: payments.map((p) => ({ method: p.method, amount: p.amount, ...(p.tendered ? { tendered: p.tendered } : {}), ...(p.reference ? { reference: p.reference } : {}) })),
      expectedTotal: allCash ? this.cart.cashDue() : this.cart.total(),
    };
    try {
      // Same id on every retry: a sale is created at most once even if approvals interrupt it.
      const sale = await this.approvals.run((h) => this.api.sell(body, h));
      this.cart.clear();
      this.paying.set(false);
      const receipt = await this.api.receipt(sale.id).catch(() => null);
      this.done.set({ sale, receipt });
      if (receipt) await this.print(receipt, payments.some((p) => p.method === 'CASH'));
      void this.state.refreshShift();
    } catch (e) {
      if (!(e instanceof ApprovalCancelled)) this.toasts.error(humanMessage(toApiError(e)));
    } finally {
      this.busy.set(false);
    }
  }

  protected async print(receipt: ReceiptDoc | null, openDrawer = false) {
    if (!receipt) return;
    const how = await this.bridge.print(receipt, openDrawer);
    if (how === 'browser' && openDrawer) this.toasts.info('Printer bridge not connected: printed with the browser, open the drawer by hand.');
  }
}
