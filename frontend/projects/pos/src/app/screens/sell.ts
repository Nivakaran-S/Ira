import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CustomerPicker } from './customer-picker';
import { ModifierPicker } from './modifier-picker';
import { PrescriptionPicker } from './prescription-picker';
import { Weigh } from './weigh';
import { type Discount, parseScaleBarcode, type ReceiptDoc, uuidv7 } from '@pos/shared';
import { humanMessage, toApiError, ToastService, UiDialog } from 'ui';
import { ApprovalCancelled, Approvals } from '../api/approvals';
import { type CatalogProduct, PosApi, type TillCustomer } from '../api/pos-api';
import { OfflineRefused, OfflineTill } from '../offline/offline-till';
import { isOfflineError } from '../offline/sync-engine';
import { HardwareBridge } from '../hardware/bridge';
import { Cart, type CartLine, listPriceOf } from '../sell/cart';
import { TillState } from '../till-state';
import { OpenShift } from './open-shift';
import { type PaymentCompletion, PaymentPanel, type PaymentDraft } from './payment-panel';
import { ReceiptView } from './receipt-view';
import { SaleJournal } from '../offline/sale-journal';

@Component({
  selector: 'pos-sell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onKey($event)' },
  imports: [UiDialog, OpenShift, PaymentPanel, ReceiptView, CustomerPicker, ModifierPicker, Weigh, PrescriptionPicker],
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
                <span class="price">{{ p.hasVariants ? variantCount(p) + ' options' : state.money(p.price) + (p.soldByWeight ? ' /kg' : '') }}</span>
                @if (p.rxRequired) { <span class="rx">Rx</span> }
              </button>
            } @empty {
              <p class="muted">No products match. Products are added in the back office under Catalog.</p>
            }
          </div>
        </section>

        <aside class="cart">
          @if (customersOn()) {
            <div class="cust">
              @if (cart.customer(); as c) {
                <span data-testid="cart-customer"><strong>{{ c.name }}</strong> <span class="small muted">{{ c.points }} pts · credit {{ state.money(c.credit) }}</span></span>
                <button type="button" class="btn small ghost" (click)="cart.customer.set(null)">Remove</button>
              } @else {
                <button type="button" class="btn small" data-testid="add-customer-btn" (click)="customerOpen.set(true)">+ Customer</button>
              }
            </div>
          }
          <div class="lines" data-testid="cart">
            @for (l of cart.lines(); track l.key) {
              <button type="button" class="line" [class.sel]="editing()?.key === l.key" (click)="edit(l)">
                <div class="l1"><span>{{ l.product.name }}</span><span>{{ state.money(cart.pricedLine(l.key)?.net ?? 0) }}</span></div>
                <div class="l2 muted small">
                  @if (l.modifiers?.length) { <div data-testid="line-modifiers">{{ modText(l) }}</div> }
                  {{ state.qty(l.qtyMilli) }} × {{ state.money(l.unitPrice ?? listPrice(l)) }}
                  @if (l.unitPrice !== undefined) { <span class="tag">price changed</span> }
                  @if (cart.pricedLine(l.key)?.discount) { <span class="tag">−{{ state.money(cart.pricedLine(l.key)!.discount) }}</span> }
                  @if (cart.promoLabel(l.key); as promo) { <span class="promo" data-testid="line-promo">{{ promo }}</span> }
                </div>
              </button>
            } @empty {
              <p class="muted empty">Tap a product to start a sale.</p>
            }
          </div>
          <div class="totals">
            <div class="r"><span>Subtotal</span><span>{{ state.money(cart.priced().totals.subtotal) }}</span></div>
            @for (p of cart.promoTotals(); track p.label) {
              <div class="r promo-row"><span>{{ p.label }}</span><span>−{{ state.money(p.amount) }}</span></div>
            }
            @if (manualDiscount()) {
              <div class="r"><span>Discounts</span><span>−{{ state.money(manualDiscount()) }}</span></div>
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
            <label class="grow">Price<input inputmode="decimal" [value]="state.money(l.unitPrice ?? listPrice(l))" (change)="setPrice(l, val($event))" /></label>
          </div>
          <label>Note<input [value]="l.note ?? ''" (change)="cart.update(l.key, { note: val($event) || undefined })" /></label>
          <div class="row-between">
            <button type="button" class="btn danger" (click)="cart.remove(l.key); editing.set(null)">Remove</button>
            <button type="button" class="btn primary" (click)="editing.set(null)">Done</button>
          </div>
        </div>
      }
    </ui-dialog>

    <ui-dialog [title]="'Choose ' + (picking()?.name ?? '')" [open]="!!picking()" (closed)="picking.set(null)">
      @if (picking(); as fam) {
        <div class="grid">
          @for (v of variantsOf(fam); track v.id) {
            <button type="button" class="tile" [attr.data-variant]="v.variantLabel" (click)="cart.add(v); picking.set(null)">
              <span class="name">{{ v.variantLabel ?? v.name }}</span>
              <span class="price">{{ state.money(v.price) }}</span>
            </button>
          }
        </div>
      }
    </ui-dialog>

    <ui-dialog [title]="modifying()?.name ?? ''" [open]="!!modifying()" (closed)="modifying.set(null)">
      @if (modifying(); as p) {
        <pos-modifier-picker [product]="p" (chosen)="cart.add(p, 1000, $event); modifying.set(null)" />
      }
    </ui-dialog>

    <ui-dialog [title]="'Weigh ' + (weighing()?.name ?? '')" [open]="!!weighing()" (closed)="weighing.set(null)">
      @if (weighing(); as p) {
        <pos-weigh [product]="p" (weighed)="cart.add(p, $event); weighing.set(null)" />
      }
    </ui-dialog>

    <ui-dialog title="Prescription" [open]="!!dispensing()" (closed)="dispensing.set(null)">
      @if (dispensing(); as p) {
        @if (cart.customer(); as c) {
          <pos-prescription-picker [product]="p" [customer]="c" (picked)="cart.add(p, $event.qtyMilli, [], $event.itemId); dispensing.set(null)" />
        }
      }
    </ui-dialog>

    <ui-dialog title="Customer" [open]="customerOpen()" (closed)="customerOpen.set(false)">
      @if (customerOpen()) {
        <pos-customer-picker (picked)="pickCustomer($event)" />
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
        <pos-payment-panel [busy]="busy()" [tips]="tipsOn()" (complete)="complete($event)" />
      }
    </ui-dialog>

    <ui-dialog title="Sale complete" [open]="!!done()" (closed)="done.set(null)">
      @if (done(); as d) {
        <div class="stack" data-testid="sale-complete">
          @if (d.change) {
            <div class="change">Change <strong data-testid="change">{{ state.money(d.change) }}</strong></div>
          }
          <div class="muted" data-testid="receipt-no-done">Receipt {{ d.receiptNo }}</div>
          @if (d.offline) {
            <div class="small offline-note" data-testid="sold-offline">Sold offline. It will reach the server when the till reconnects.</div>
          }
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
    .cust { display: flex; justify-content: space-between; align-items: center; padding: var(--s2) var(--s4); border-bottom: 1px solid var(--border); background: var(--surface-2); }
    .promo { background: var(--ok-soft); color: var(--ok); padding: 0 6px; border-radius: 6px; margin-left: 4px; }
    .promo-row { color: var(--ok); }
    .rx { font-size: 11px; font-weight: 700; color: var(--danger); border: 1px solid var(--danger); border-radius: 4px; padding: 0 4px; }
    .offline-note { background: var(--warn-soft); color: var(--warn); padding: var(--s2) var(--s3); border-radius: var(--radius); }
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
  private readonly offlineTill = inject(OfflineTill);
  private readonly journal = inject(SaleJournal);

  protected readonly query = signal('');
  protected readonly category = signal<string | null>(null);
  protected readonly editing = signal<CartLine | null>(null);
  protected readonly cartDiscountOpen = signal(false);
  protected readonly paying = signal(false);
  protected readonly busy = signal(false);
  protected readonly done = signal<{ receiptNo: string; change: number; receipt: ReceiptDoc | null; offline: boolean } | null>(null);
  protected readonly picking = signal<CatalogProduct | null>(null);
  protected readonly modifying = signal<CatalogProduct | null>(null);
  protected readonly weighing = signal<CatalogProduct | null>(null);
  protected readonly dispensing = signal<CatalogProduct | null>(null);
  protected readonly tipsOn = computed(() => (this.state.catalog()?.modules ?? []).includes('tables'));
  protected readonly listPrice = listPriceOf;
  protected modText(l: CartLine) {
    return (l.modifiers ?? []).map((m) => m.name).join(', ');
  }
  protected readonly customerOpen = signal(false);
  protected readonly customersOn = computed(() => (this.state.catalog()?.modules ?? []).includes('customers'));
  protected readonly manualDiscount = computed(() => this.cart.priced().totals.discountTotal - this.cart.promoTotals().reduce((s, p) => s + p.amount, 0));

  /** The grid shows standalone products and variant families; searching also finds individual variants. */
  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const cat = this.category();
    return (this.state.catalog()?.products ?? []).filter(
      (p) => (!cat || p.categoryId === cat) && (q ? (p.name.toLowerCase().includes(q) || p.sku?.toLowerCase() === q) && !p.hasVariants : !p.parentId),
    );
  });

  // A keyboard-wedge scanner types a whole code within milliseconds and ends with Enter.
  private scanBuffer = '';
  private lastKeyAt = 0;

  protected onKey(e: KeyboardEvent) {
    // Typing in a field (search, quantities) is handled by that field; the search box takes scans itself.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const now = performance.now();
    if (now - this.lastKeyAt > 60) this.scanBuffer = '';
    this.lastKeyAt = now;
    if (e.key === 'Enter') {
      const code = this.scanBuffer;
      this.scanBuffer = '';
      if (code.length >= 3 && this.scan(code)) {
        e.preventDefault();
        this.query.set('');
      }
    } else if (e.key.length === 1) this.scanBuffer += e.key;
  }

  /** Adds the product with this barcode or SKU. True when something matched. */
  scan(code: string): boolean {
    const cat = this.state.catalog();
    if (!cat || this.paying() || !this.state.shiftOpen()) return false;
    // In-store scale labels carry the PLU and the weight (or price) in the code itself.
    const label = cat.settings.scaleBarcode?.enabled ? parseScaleBarcode(code, cat.settings.scaleBarcode) : null;
    if (label) {
      const item = cat.products.find((p) => p.plu === label.plu);
      if (!item) {
        this.toasts.error(`No product with PLU ${label.plu}`);
        return true;
      }
      const qty = label.valueType === 'weight' ? label.value : Math.max(1, Math.round((label.value * 1000) / Math.max(1, item.price)));
      this.cart.add(item, qty);
      return true;
    }
    const id = cat.barcodes?.[code];
    const product = cat.products.find((p) => (id ? p.id === id : p.sku === code) && !p.hasVariants);
    if (!product) {
      if (id || /^[0-9]{8,14}$/.test(code)) this.toasts.error(`Unknown barcode ${code}`);
      return false;
    }
    this.add(product);
    return true;
  }

  protected variantsOf(family: CatalogProduct) {
    return (this.state.catalog()?.products ?? []).filter((p) => p.parentId === family.id);
  }

  protected variantCount(family: CatalogProduct) {
    return this.variantsOf(family).length;
  }

  /** A prescription medicine tapped before the customer was on the sale. */
  private pendingRx: CatalogProduct | null = null;

  protected pickCustomer(c: TillCustomer) {
    this.cart.customer.set(c);
    this.customerOpen.set(false);
    if (this.pendingRx) this.dispensing.set(this.pendingRx);
    this.pendingRx = null;
  }

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected add(p: CatalogProduct) {
    if (p.hasVariants) this.picking.set(p);
    else if (p.rxRequired) {
      if (this.state.offline()) return this.toasts.error('Prescription medicines can only be sold online.');
      if (!this.cart.customer()) {
        this.toasts.info('Prescription medicine: add the customer first.');
        this.pendingRx = p;
        this.customerOpen.set(true);
        return;
      }
      this.dispensing.set(p);
    } else if (p.soldByWeight) this.weighing.set(p);
    else if (p.modifierGroups?.length) this.modifying.set(p);
    else this.cart.add(p);
  }

  protected addFirst() {
    if (this.scan(this.query().trim())) {
      this.query.set('');
      return;
    }
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
    this.cart.update(l.key, { unitPrice: v === listPriceOf(l) ? undefined : v });
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

  protected async complete({ payments, tip, settle }: PaymentCompletion) {
    if (this.busy()) return settle(false);
    this.busy.set(true);
    // One id for this sale whichever way it goes: if an online attempt did reach the server, the
    // offline copy syncs as a duplicate instead of a second sale.
    const id = uuidv7();
    let recorded = false;
    try {
      if (this.state.offline()) await this.completeOffline(payments, id, tip);
      else {
        try {
          await this.completeOnline(payments, id, tip);
        } catch (e) {
          if (!isOfflineError(e)) throw e;
          this.state.sync.online.set(false);
          await this.completeOffline(payments, id, tip);
        }
      }
      recorded = true;
    } catch (e) {
      if (e instanceof OfflineRefused) this.toasts.error(e.message);
      else if (!(e instanceof ApprovalCancelled)) this.toasts.error(humanMessage(toApiError(e)));
    } finally {
      settle(recorded);
      this.busy.set(false);
    }
  }

  private async completeOnline(payments: PaymentDraft[], id: string, tip: number) {
    const allCash = payments.every((p) => p.method === 'CASH');
    const body = {
      id,
      ...(this.cart.customer() ? { customerId: this.cart.customer()!.id } : {}),
      ...(tip ? { tip } : {}),
      lines: this.cart.lines().map((l) => ({
        productId: l.product.id,
        qtyMilli: l.qtyMilli,
        ...(l.unitPrice !== undefined ? { unitPrice: l.unitPrice } : {}),
        ...(l.discount ? { discount: l.discount } : {}),
        ...(l.note ? { note: l.note } : {}),
        ...(l.modifiers?.length ? { modifierIds: l.modifiers.map((m) => m.id) } : {}),
        ...(l.prescriptionItemId ? { prescriptionItemId: l.prescriptionItemId } : {}),
      })),
      ...(this.cart.cartDiscount() ? { cartDiscount: this.cart.cartDiscount()! } : {}),
      payments: payments.map((p) => ({ method: p.method, amount: p.amount, ...(p.tendered ? { tendered: p.tendered } : {}), ...(p.reference ? { reference: p.reference } : {}), ...(p.card ? { card: p.card } : {}) })),
      expectedTotal: allCash ? this.cart.cashDue() : this.cart.total(),
    };
    // Same id on every retry: a sale is created at most once even if approvals interrupt it.
    const sale = await this.approvals.run((h) => this.api.sell(body, h));
    await this.journal.put(sale).catch(() => undefined);
    this.cart.clear();
    this.paying.set(false);
    const receipt = await this.api.receipt(sale.id).catch(() => null);
    this.done.set({ receiptNo: sale.receiptNo, change: sale.change, receipt, offline: false });
    if (receipt) await this.print(receipt, payments.some((p) => p.method === 'CASH'));
    void this.state.refreshShift();
  }

  private async completeOffline(payments: PaymentDraft[], id: string, tip: number) {
    const r = await this.offlineTill.sell(payments, id, tip);
    this.cart.clear();
    this.paying.set(false);
    this.done.set({ receiptNo: r.receiptNo, change: r.change, receipt: r.receipt, offline: true });
    await this.print(r.receipt, payments.some((p) => p.method === 'CASH'));
  }

  protected async print(receipt: ReceiptDoc | null, openDrawer = false) {
    if (!receipt) return;
    const how = await this.bridge.print(receipt, openDrawer);
    if (how === 'browser' && openDrawer) this.toasts.info('Printer bridge not connected: printed with the browser, open the drawer by hand.');
  }
}
