import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { type PromotionDef, type PromotionKind } from '@pos/shared';
import { apiResource, fieldErrors, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty, UiField } from 'ui';
import { CommerceApi } from './commerce-api';
import { Money } from './money';
import { RetailApi } from './retail-api';

const KINDS: { key: PromotionKind; label: string }[] = [
  { key: 'PERCENT_OFF', label: 'Percent off items' },
  { key: 'AMOUNT_OFF', label: 'Amount off each item' },
  { key: 'BUY_X_GET_Y', label: 'Buy X, get Y' },
  { key: 'SPEND_THRESHOLD', label: 'Spend and save' },
];

@Component({
  selector: 'admin-promotions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, UiBadge, UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Promotions</h1>
        <button class="btn primary" type="button" data-testid="new-promotion" (click)="edit(null)">New promotion</button>
      </div>
      <p class="small muted">Applied automatically on every till, also offline. Each item gets the best item promotion; one spend promotion applies per sale.</p>
      <section class="card flush">
        @if (list.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Name</th><th>Rule</th><th>Applies to</th><th>Dates</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (p of list.value(); track p.id) {
                <tr [attr.data-promotion]="p.name">
                  <td>{{ p.name }}</td>
                  <td class="small">{{ describe(p) }}</td>
                  <td class="small">{{ scope(p) }}</td>
                  <td class="small">{{ p.startsAt ? (p.startsAt | date: 'mediumDate') : '' }} – {{ p.endsAt ? (p.endsAt | date: 'mediumDate') : '' }}</td>
                  <td><ui-badge [tone]="p.active ? 'ok' : 'neutral'">{{ p.active ? 'On' : 'Off' }}</ui-badge></td>
                  <td><button class="btn small" type="button" (click)="edit(p)">Edit</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="list.errorMessage() ?? (list.isLoading() ? 'Loading…' : 'No promotions yet')" />
        }
      </section>
    </div>

    <ui-dialog [title]="editingId() ? 'Edit promotion' : 'New promotion'" [open]="open()" (closed)="open.set(false)">
      <form class="stack" data-testid="promotion-form" (submit)="$event.preventDefault(); save()">
        <ui-field label="Name" for="pr-name" hint="Shown on receipts" [error]="errors()['name']"><input id="pr-name" [value]="name()" (input)="name.set(val($event))" /></ui-field>
        <ui-field label="Kind" for="pr-kind">
          <select id="pr-kind" [value]="kind()" (change)="setKind(val($event))">
            @for (k of kinds; track k.key) { <option [value]="k.key">{{ k.label }}</option> }
          </select>
        </ui-field>
        <div class="grid-2">
          @if (kind() === 'PERCENT_OFF' || kind() === 'SPEND_THRESHOLD') {
            <ui-field label="Percent off" for="pr-pct" [error]="errors()['percentBp']"><input id="pr-pct" inputmode="decimal" [value]="pct()" (input)="pct.set(val($event))" /></ui-field>
          }
          @if (kind() === 'AMOUNT_OFF' || kind() === 'SPEND_THRESHOLD') {
            <ui-field [label]="kind() === 'AMOUNT_OFF' ? 'Amount off each' : 'Or amount off'" for="pr-amt" [error]="errors()['amount']"><input id="pr-amt" inputmode="decimal" [value]="amount()" (input)="amount.set(val($event))" /></ui-field>
          }
          @if (kind() === 'BUY_X_GET_Y') {
            <ui-field label="Buy" for="pr-buy"><input id="pr-buy" inputmode="numeric" [value]="buy()" (input)="buy.set(val($event))" /></ui-field>
            <ui-field label="Get" for="pr-get"><input id="pr-get" inputmode="numeric" [value]="get()" (input)="get.set(val($event))" /></ui-field>
            <ui-field label="At percent off" for="pr-getpct" hint="100 = free"><input id="pr-getpct" inputmode="decimal" [value]="getPct()" (input)="getPct.set(val($event))" /></ui-field>
          }
          @if (kind() === 'SPEND_THRESHOLD') {
            <ui-field label="When the sale reaches" for="pr-min"><input id="pr-min" inputmode="decimal" [value]="minSpend()" (input)="minSpend.set(val($event))" /></ui-field>
          }
        </div>
        @if (kind() !== 'SPEND_THRESHOLD') {
          <fieldset>
            <legend>Applies to (nothing ticked = everything)</legend>
            @for (c of categories.value() ?? []; track c.id) {
              <label class="check"><input type="checkbox" [attr.data-cat]="c.name" [checked]="catIds().includes(c.id)" (change)="toggle(catIds, c.id, checked($event))" /> Category: {{ c.name }}</label>
            }
            @for (p of products(); track p.id) {
              <label class="check"><input type="checkbox" [attr.data-prod]="p.name" [checked]="prodIds().includes(p.id)" (change)="toggle(prodIds, p.id, checked($event))" /> {{ p.name }}</label>
            }
          </fieldset>
        }
        <div class="grid-2">
          <ui-field label="Starts (optional)" for="pr-start"><input id="pr-start" type="date" [value]="starts()" (change)="starts.set(val($event))" /></ui-field>
          <ui-field label="Ends (optional)" for="pr-end"><input id="pr-end" type="date" [value]="ends()" (change)="ends.set(val($event))" /></ui-field>
        </div>
        <label class="check"><input type="checkbox" [checked]="active()" (change)="active.set(checked($event))" /> On</label>
        <div><button class="btn primary" type="submit" [disabled]="!name().trim()">Save</button></div>
      </form>
    </ui-dialog>
  `,
  styles: `
    fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s3); max-height: 220px; overflow: auto; display: grid; gap: var(--s1); }
    .check { display: flex; gap: var(--s2); align-items: center; }
  `,
})
export class Promotions {
  private readonly api = inject(RetailApi);
  private readonly commerce = inject(CommerceApi);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly kinds = KINDS;
  protected readonly list = apiResource({ loader: () => this.api.promotions() });
  protected readonly categories = apiResource({ loader: () => this.commerce.categories() });
  private readonly allProducts = apiResource({ loader: () => this.commerce.products(false) });
  protected readonly products = computed(() => (this.allProducts.value() ?? []).filter((p) => !(p as { hasVariants?: boolean }).hasVariants));

  protected readonly open = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly kind = signal<PromotionKind>('PERCENT_OFF');
  protected readonly pct = signal('');
  protected readonly amount = signal('');
  protected readonly buy = signal('2');
  protected readonly get = signal('1');
  protected readonly getPct = signal('100');
  protected readonly minSpend = signal('');
  protected readonly catIds = signal<string[]>([]);
  protected readonly prodIds = signal<string[]>([]);
  protected readonly starts = signal('');
  protected readonly ends = signal('');
  protected readonly active = signal(true);
  protected readonly errors = signal<Record<string, string>>({});

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected checked(e: Event) {
    return (e.target as HTMLInputElement).checked;
  }
  protected setKind(v: string) {
    this.kind.set(v as PromotionKind);
  }
  protected toggle(list: typeof this.catIds, id: string, on: boolean) {
    list.update((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  }

  protected describe(p: PromotionDef) {
    switch (p.kind) {
      case 'PERCENT_OFF':
        return `${this.money.pct(p.percentBp ?? 0)} off`;
      case 'AMOUNT_OFF':
        return `${this.money.fmt(p.amount ?? 0)} off each`;
      case 'BUY_X_GET_Y':
        return `Buy ${p.buyQty}, get ${p.getQty} ${p.getPercentBp && p.getPercentBp < 10_000 ? `${this.money.pct(p.getPercentBp)} off` : 'free'}`;
      case 'SPEND_THRESHOLD':
        return `Spend ${this.money.fmt(p.minSpend ?? 0)}: ${p.percentBp ? this.money.pct(p.percentBp) : this.money.fmt(p.amount ?? 0)} off`;
    }
  }
  protected scope(p: PromotionDef) {
    if (p.kind === 'SPEND_THRESHOLD') return 'The whole sale';
    const n = p.productIds.length + p.categoryIds.length;
    return n ? `${p.categoryIds.length} categories, ${p.productIds.length} products` : 'Everything';
  }

  protected edit(p: PromotionDef | null) {
    this.editingId.set(p?.id ?? null);
    this.name.set(p?.name ?? '');
    this.kind.set(p?.kind ?? 'PERCENT_OFF');
    this.pct.set(p?.percentBp ? String(p.percentBp / 100) : '');
    this.amount.set(p?.amount ? this.money.fmt(p.amount).replace(/,/g, '') : '');
    this.buy.set(String(p?.buyQty ?? 2));
    this.get.set(String(p?.getQty ?? 1));
    this.getPct.set(String((p?.getPercentBp ?? 10_000) / 100));
    this.minSpend.set(p?.minSpend ? this.money.fmt(p.minSpend).replace(/,/g, '') : '');
    this.catIds.set(p?.categoryIds ?? []);
    this.prodIds.set(p?.productIds ?? []);
    this.starts.set(p?.startsAt?.slice(0, 10) ?? '');
    this.ends.set(p?.endsAt?.slice(0, 10) ?? '');
    this.active.set(p?.active ?? true);
    this.errors.set({});
    this.open.set(true);
  }

  protected async save() {
    const bp = (t: string) => (t.trim() ? Math.round(Number(t) * 100) : undefined);
    const minor = (t: string) => (t.trim() ? (this.money.parse(t) ?? undefined) : undefined);
    const k = this.kind();
    const input = {
      name: this.name().trim(),
      kind: k,
      productIds: k === 'SPEND_THRESHOLD' ? [] : this.prodIds(),
      categoryIds: k === 'SPEND_THRESHOLD' ? [] : this.catIds(),
      active: this.active(),
      startsAt: this.starts() ? new Date(`${this.starts()}T00:00:00`).toISOString() : null,
      endsAt: this.ends() ? new Date(`${this.ends()}T23:59:59`).toISOString() : null,
      ...(k === 'PERCENT_OFF' || k === 'SPEND_THRESHOLD' ? { percentBp: bp(this.pct()) } : {}),
      ...(k === 'AMOUNT_OFF' || k === 'SPEND_THRESHOLD' ? { amount: minor(this.amount()) } : {}),
      ...(k === 'BUY_X_GET_Y' ? { buyQty: Number(this.buy()), getQty: Number(this.get()), getPercentBp: bp(this.getPct()) } : {}),
      ...(k === 'SPEND_THRESHOLD' ? { minSpend: minor(this.minSpend()) } : {}),
    };
    try {
      await this.api.savePromotion(input, this.editingId() ?? undefined);
      this.toasts.success('Promotion saved');
      this.open.set(false);
      this.list.reload();
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.toasts.error(humanMessage(err));
    }
  }
}
