import { ChangeDetectionStrategy, Component, computed, inject, input, type OnDestroy, output, signal } from '@angular/core';
import { cashRound, uuidv7 } from '@pos/shared';
import type { CardResult, PaymentMethodKey } from '@pos/shared';
import { cardOf, HardwareBridge } from '../hardware/bridge';
import { Cart } from '../sell/cart';
import { TillState } from '../till-state';

export interface PaymentDraft {
  method: PaymentMethodKey;
  amount: number;
  tendered?: number;
  reference?: string;
  /** Charged on the integrated terminal. */
  card?: CardResult;
}

/** What the panel hands over; the parent says whether the sale was recorded, so terminal charges can be undone if not. */
export interface PaymentCompletion {
  payments: PaymentDraft[];
  tip: number;
  settle(recorded: boolean): void;
}

const LABEL: Record<PaymentMethodKey, string> = { CASH: 'Cash', CARD: 'Card', OTHER: 'Other', LOYALTY: 'Points', STORE_CREDIT: 'Store credit' };

/**
 * Takes one or more payments for the cart. All-cash sales are due at the cash-rounded total;
 * as soon as any non-cash payment is involved the exact total is due.
 */
@Component({
  selector: 'pos-payment-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack" data-testid="payment">
      <div class="due">
        <span class="muted">{{ paid().length ? 'Remaining' : 'To pay' }}</span>
        <strong data-testid="due">{{ state.money(remaining()) }}</strong>
      </div>
      @if (tips()) {
        <div class="row tip">
          <span class="muted">Tip</span>
          @for (p of [5, 10, 15]; track p) {
            <button type="button" class="btn small" (click)="setTipPct(p)">{{ p }}%</button>
          }
          <input aria-label="Tip" inputmode="decimal" data-testid="tip" [value]="tipText()" (input)="tipText.set(val($event))" style="max-width: 120px" />
        </div>
      }

      @for (p of paid(); track $index) {
        <div class="row-between small"><span>{{ label[p.method] }}{{ p.card ? ' ' + p.card.scheme + ' ****' + p.card.last4 : '' }} {{ p.reference ? '· ' + p.reference : '' }}</span><span>{{ state.money(p.amount) }}</span></div>
      }

      <div class="methods">
        @for (m of methods(); track m) {
          <button type="button" class="btn" [class.primary]="method() === m" [attr.data-method]="m" (click)="pick(m)">{{ label[m] }}</button>
        }
      </div>

      @if (method() === 'CASH') {
        <label>Cash received
          <input inputmode="decimal" data-testid="tendered" [value]="tenderedText()" (input)="tenderedText.set(val($event))" />
        </label>
        <div class="quick">
          @for (q of quick(); track q) {
            <button type="button" class="btn" (click)="tenderedText.set(state.money(q))">{{ state.money(q) }}</button>
          }
        </div>
        @if (change() > 0) {
          <div class="change">Change {{ state.money(change()) }}</div>
        }
      } @else {
        <label>Amount
          <input inputmode="decimal" [value]="amountText()" (input)="amountText.set(val($event))" />
        </label>
        @if (method() === 'LOYALTY') {
          <p class="small muted" data-testid="points-note">{{ cart.customer()?.points }} points available, each worth {{ state.money(pointValue()) }}. Pay in whole points.</p>
        } @else if (method() === 'STORE_CREDIT') {
          <p class="small muted">{{ state.money(cart.customer()?.credit ?? 0) }} store credit available.</p>
        } @else if (method() === 'CARD' && terminalOn()) {
          <p class="small muted" data-testid="terminal-note">{{ charging() ? 'Waiting for the card on the terminal…' : 'The card terminal will ask for the card.' }}</p>
        } @else {
          <label>{{ method() === 'CARD' ? 'Terminal approval code' : 'Reference' }} (optional)
            <input data-testid="reference" [value]="reference()" (input)="reference.set(val($event))" />
          </label>
        }
      }

      @if (error()) {
        <div class="error-text" role="alert">{{ error() }}</div>
      }
      <div class="row-between">
        @if (canSplit()) {
          <button type="button" class="btn" [disabled]="charging()" (click)="addPart()">Add as part payment</button>
        } @else {
          <span></span>
        }
        <button type="button" class="btn primary go" data-testid="complete" [disabled]="busy() || charging()" (click)="finish()">
          {{ method() === 'CARD' && terminalOn() && remaining() > 0 ? 'Charge card' : 'Complete sale' }}
        </button>
      </div>
    </div>
  `,
  styles: `
    .due { display: flex; justify-content: space-between; align-items: baseline; font-size: 18px; }
    .due strong { font-size: 30px; }
    .methods { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s2); }
    .methods .btn { min-height: 56px; font-size: 17px; }
    .quick { display: flex; gap: var(--s2); flex-wrap: wrap; }
    label { display: flex; flex-direction: column; gap: 4px; font-weight: 550; }
    .change { font-size: 22px; font-weight: 700; color: var(--ok); text-align: center; }
    .go { min-height: 52px; min-width: 180px; font-size: 17px; }
  `,
})
export class PaymentPanel implements OnDestroy {
  protected readonly state = inject(TillState);
  protected readonly cart = inject(Cart);
  private readonly bridge = inject(HardwareBridge);
  protected readonly terminalOn = computed(() => this.bridge.hasTerminal());
  protected readonly charging = signal(false);
  /** The sale these payments belong to was recorded: terminal charges stand. */
  private settled = false;

  constructor() {
    if (!this.bridge.health()) void this.bridge.check();
  }
  readonly busy = input(false);
  /** Offer a tip field (restaurants). */
  readonly tips = input(false);
  /** Totals for something other than the cart (an order being paid); defaults to the cart. */
  readonly total = input<number | null>(null);
  readonly complete = output<PaymentCompletion>();
  protected readonly tipText = signal('');
  protected readonly tip = computed(() => (this.tips() ? (this.state.parse(this.tipText()) ?? 0) : 0));
  private readonly baseTotal = computed(() => this.total() ?? this.cart.total());
  private readonly baseCashTotal = computed(() => (this.total() === null ? this.cart.cashDue() : cashRound(this.total()!, this.cart.settings()?.cashRoundingUnit ?? 1)));

  /** Points and store credit appear when a customer with a balance is on the sale. */
  protected readonly methods = computed<PaymentMethodKey[]>(() => {
    const out: PaymentMethodKey[] = ['CASH', 'CARD', 'OTHER'];
    const c = this.cart.customer();
    const cat = this.state.catalog();
    if (c) {
      const loyalty = this.cart.settings()?.loyalty;
      if ((cat?.modules ?? []).includes('loyalty') && loyalty && c.points >= loyalty.minRedeemPoints) out.push('LOYALTY');
      if (c.credit > 0) out.push('STORE_CREDIT');
    }
    return out;
  });
  protected readonly pointValue = computed(() => this.cart.settings()?.loyalty.pointValue ?? 1);
  protected readonly label = LABEL;
  protected readonly method = signal<PaymentMethodKey>('CASH');
  protected readonly paid = signal<PaymentDraft[]>([]);
  protected readonly tenderedText = signal('');
  protected readonly amountText = signal('');
  protected readonly reference = signal('');
  protected readonly error = signal<string | null>(null);

  private readonly allCash = computed(() => this.method() === 'CASH' && this.paid().every((p) => p.method === 'CASH'));
  /** What the sale costs given the methods in play. */
  private readonly due = computed(() => (this.allCash() ? this.baseCashTotal() : this.baseTotal()) + this.tip());
  protected readonly remaining = computed(() => Math.max(0, this.due() - this.paid().reduce((s, p) => s + p.amount, 0)));
  private readonly tendered = computed(() => this.state.parse(this.tenderedText()) ?? 0);
  protected readonly change = computed(() => Math.max(0, this.tendered() - this.remaining()));
  protected readonly canSplit = computed(() => this.method() !== 'CASH' && this.paid().length < 5);

  /** Exact, then the next round notes above it. */
  protected readonly quick = computed(() => {
    const r = this.remaining();
    const out = new Set<number>([r]);
    for (const unit of [10_000, 50_000, 100_000, 500_000]) out.add(Math.ceil(r / unit) * unit);
    return [...out].filter((v) => v >= r).sort((a, b) => a - b).slice(0, 4);
  });

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected pick(m: PaymentMethodKey) {
    this.method.set(m);
    this.error.set(null);
    this.amountText.set(this.state.money(this.defaultAmount(m)));
  }

  /** What a method can cover at most: the rest of the bill, capped by a balance for points and credit. */
  private defaultAmount(m: PaymentMethodKey) {
    const rest = this.nonCashRemaining();
    const c = this.cart.customer();
    if (m === 'LOYALTY' && c) return Math.min(rest - (rest % this.pointValue()), c.points * this.pointValue());
    if (m === 'STORE_CREDIT' && c) return Math.min(rest, c.credit);
    return rest;
  }

  private checkBalance(m: PaymentMethodKey, amount: number): string | null {
    const c = this.cart.customer();
    if (m === 'LOYALTY') {
      if (amount % this.pointValue() !== 0) return `Points pay in steps of ${this.state.money(this.pointValue())}.`;
      if (!c || amount / this.pointValue() > c.points) return 'Not enough points.';
    }
    if (m === 'STORE_CREDIT' && (!c || amount > c.credit)) return 'Not enough store credit.';
    return null;
  }

  private nonCashRemaining() {
    return Math.max(0, this.baseTotal() + this.tip() - this.paid().reduce((s, p) => s + p.amount, 0));
  }

  protected setTipPct(p: number) {
    this.tipText.set(this.state.money(Math.round((this.baseTotal() * p) / 100)));
  }

  /** Charges the card on the terminal; null (with the reason shown) when it was not approved. */
  private async charge(amount: number): Promise<PaymentDraft | null> {
    this.charging.set(true);
    try {
      const r = await this.bridge.terminal('sale', amount, this.state.currency(), uuidv7());
      if (r.status !== 'APPROVED') {
        this.error.set(`Card ${r.status === 'DECLINED' ? 'declined' : 'cancelled'}${r.message ? `: ${r.message}` : ''}.`);
        return null;
      }
      return { method: 'CARD', amount, reference: r.authCode, card: cardOf(r) };
    } catch (e) {
      this.error.set((e as Error).message);
      return null;
    } finally {
      this.charging.set(false);
    }
  }

  /** Gives terminal charges back, e.g. when the sale could not be recorded. */
  private async reverse(parts: PaymentDraft[]) {
    const charged = parts.filter((p) => p.card);
    if (!charged.length) return;
    const failed: PaymentDraft[] = [];
    for (const p of charged) {
      try {
        const r = await this.bridge.terminal('refund', p.amount, this.state.currency(), `rev-${p.card!.terminalRef}`.slice(0, 64), p.card!.terminalRef);
        if (r.status !== 'APPROVED') failed.push(p);
      } catch {
        failed.push(p);
      }
    }
    this.paid.update((list) => list.filter((p) => !p.card));
    this.error.set(failed.length ? 'A card payment could not be reversed on the terminal. Refund it there by hand.' : 'The card payments were reversed on the terminal.');
  }

  ngOnDestroy() {
    if (!this.settled) void this.reverse(this.paid());
  }

  protected async addPart() {
    const amount = this.state.parse(this.amountText());
    if (!amount || amount <= 0 || amount > this.nonCashRemaining()) return this.error.set('Enter an amount up to what is left to pay.');
    const balanceError = this.checkBalance(this.method(), amount);
    if (balanceError) return this.error.set(balanceError);
    let part: PaymentDraft | null = { method: this.method(), amount, ...(this.reference().trim() ? { reference: this.reference().trim() } : {}) };
    if (this.method() === 'CARD' && this.terminalOn()) part = await this.charge(amount);
    if (!part) return;
    this.paid.update((p) => [...p, part]);
    this.reference.set('');
    this.error.set(null);
    this.method.set('CASH');
  }

  protected async finish() {
    this.error.set(null);
    const rest = this.remaining();
    let parts = this.paid();
    if (rest > 0) {
      if (this.method() === 'CASH') {
        const tendered = this.tenderedText().trim() ? this.tendered() : rest;
        if (tendered < rest) return this.error.set('Cash received is less than the amount to pay.');
        parts = [...parts, { method: 'CASH', amount: rest, tendered }];
      } else {
        const amount = this.state.parse(this.amountText()) ?? rest;
        if (amount !== rest) return this.error.set('This amount must cover what is left; use part payments to split.');
        const balanceError = this.checkBalance(this.method(), amount);
        if (balanceError) return this.error.set(balanceError);
        let part: PaymentDraft | null = { method: this.method(), amount, ...(this.reference().trim() ? { reference: this.reference().trim() } : {}) };
        if (this.method() === 'CARD' && this.terminalOn()) {
          part = await this.charge(amount);
          if (!part) return;
          // Charged: keep it with the other parts, so it is reversed if the sale is not recorded.
          this.paid.update((p) => [...p, part!]);
          parts = this.paid();
        } else parts = [...parts, part];
      }
    }
    if (!parts.length) return this.error.set('Nothing to pay.');
    const attempt = parts;
    this.complete.emit({
      payments: attempt,
      tip: this.tip(),
      settle: (recorded) => {
        // The first answer counts: once recorded, a later failure (printing, say) must not undo the charge.
        if (this.settled) return;
        if (recorded) this.settled = true;
        else void this.reverse(attempt);
      },
    });
  }
}
