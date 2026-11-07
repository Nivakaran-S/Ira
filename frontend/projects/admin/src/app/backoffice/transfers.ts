import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty, UiField } from 'ui';
import { BackofficeApi } from './backoffice-api';
import { CommerceApi } from './commerce-api';
import { Money } from './money';

interface Transfer {
  id: string;
  number: string;
  fromStoreId: string;
  toStoreId: string;
  status: 'SENT' | 'RECEIVED' | 'CANCELLED';
  sentAt: string;
  lines: { id: string; productId: string; qtyMilli: number; receivedQtyMilli: number | null }[];
}

/** Stock between stores: it leaves the sender at once and arrives when the receiver confirms. */
@Component({
  selector: 'admin-transfers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, UiBadge, UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Stock transfers</h1>
        <button class="btn primary" type="button" data-testid="new-transfer" (click)="startNew()">New transfer</button>
      </div>
      <section class="card flush">
        @if (list.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Transfer</th><th>From → to</th><th>Sent</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (t of list.value(); track t.id) {
                <tr [attr.data-transfer]="t.number">
                  <td class="mono">{{ t.number }}</td>
                  <td>{{ storeCode(t.fromStoreId) }} → {{ storeCode(t.toStoreId) }}</td>
                  <td class="small">{{ t.sentAt | date: 'short' }}</td>
                  <td><ui-badge [tone]="t.status === 'RECEIVED' ? 'ok' : t.status === 'SENT' ? 'warn' : 'neutral'">{{ t.status === 'SENT' ? 'In transit' : t.status }}</ui-badge></td>
                  <td>
                    @if (t.status === 'SENT') {
                      <button class="btn small" type="button" (click)="receiving.set(t)">Receive</button>
                      <button class="btn small" type="button" (click)="cancel(t)">Cancel</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="list.errorMessage() ?? (list.isLoading() ? 'Loading…' : 'No transfers yet')" />
        }
      </section>
    </div>

    <ui-dialog title="New transfer" [open]="creating()" (closed)="creating.set(false)">
      <form class="stack" data-testid="transfer-form" (submit)="$event.preventDefault(); send()">
        <div class="grid-2">
          <ui-field label="From" for="tr-from">
            <select id="tr-from" [value]="from()" (change)="from.set(val($event))">
              @for (s of stores.value() ?? []; track s.id) { <option [value]="s.id">{{ s.code }} · {{ s.name }}</option> }
            </select>
          </ui-field>
          <ui-field label="To" for="tr-to">
            <select id="tr-to" [value]="to()" (change)="to.set(val($event))">
              @for (s of stores.value() ?? []; track s.id) { <option [value]="s.id">{{ s.code }} · {{ s.name }}</option> }
            </select>
          </ui-field>
          <ui-field label="Product" for="tr-prod">
            <select id="tr-prod" [value]="productId()" (change)="productId.set(val($event))">
              <option value="">Choose…</option>
              @for (p of products(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
            </select>
          </ui-field>
          <ui-field label="Quantity" for="tr-qty"><input id="tr-qty" inputmode="decimal" [value]="qty()" (input)="qty.set(val($event))" /></ui-field>
        </div>
        <div><button class="btn primary" type="submit" [disabled]="!productId() || !(+qty() > 0) || from() === to()">Send</button></div>
      </form>
    </ui-dialog>

    <ui-dialog [title]="'Receive ' + (receiving()?.number ?? '')" [open]="!!receiving()" (closed)="receiving.set(null)">
      @if (receiving(); as t) {
        <div class="stack">
          <p class="small muted">Enter what actually arrived if it differs from what was sent.</p>
          @for (l of t.lines; track l.id) {
            <div class="row">
              <span class="grow">{{ productName(l.productId) }} (sent {{ money.qty(l.qtyMilli) }})</span>
              <input [attr.aria-label]="'Arrived ' + productName(l.productId)" inputmode="decimal" [placeholder]="money.qty(l.qtyMilli)" [value]="arrived()[l.id] ?? ''" (input)="setArrived(l.id, val($event))" style="max-width: 100px" />
            </div>
          }
          <div><button class="btn primary" type="button" data-testid="confirm-receive" (click)="receive(t)">Confirm received</button></div>
        </div>
      }
    </ui-dialog>
  `,
  styles: `.grow { flex: 1; }`,
})
export class Transfers {
  private readonly http = inject(HttpClient);
  private readonly bo = inject(BackofficeApi);
  private readonly commerce = inject(CommerceApi);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly list = apiResource({ loader: () => firstValueFrom(this.http.get<Transfer[]>('/api/transfers')) });
  protected readonly stores = apiResource({ loader: () => this.bo.stores() });
  private readonly allProducts = apiResource({ loader: () => this.commerce.products(false) });
  protected readonly products = computed(() => (this.allProducts.value() ?? []).filter((p) => p.trackStock && !(p as { hasVariants?: boolean }).hasVariants));
  protected readonly creating = signal(false);
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly productId = signal('');
  protected readonly qty = signal('');
  protected readonly receiving = signal<Transfer | null>(null);
  protected readonly arrived = signal<Record<string, string>>({});

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected storeCode(id: string) {
    return this.stores.value()?.find((s) => s.id === id)?.code ?? '';
  }
  protected productName(id: string) {
    return this.allProducts.value()?.find((p) => p.id === id)?.name ?? '';
  }
  protected setArrived(id: string, v: string) {
    this.arrived.update((a) => ({ ...a, [id]: v }));
  }

  protected startNew() {
    const s = this.stores.value() ?? [];
    this.from.set(s[0]?.id ?? '');
    this.to.set(s[1]?.id ?? '');
    this.productId.set('');
    this.qty.set('');
    this.creating.set(true);
  }

  private async attempt(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      this.toasts.success(ok);
      this.list.reload();
      return true;
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
      return false;
    }
  }

  protected async send() {
    if (
      await this.attempt(
        () => firstValueFrom(this.http.post('/api/transfers', { fromStoreId: this.from(), toStoreId: this.to(), lines: [{ productId: this.productId(), qtyMilli: Math.round(+this.qty() * 1000) }] })),
        'Transfer sent',
      )
    )
      this.creating.set(false);
  }

  protected async receive(t: Transfer) {
    const lines = Object.entries(this.arrived())
      .filter(([, v]) => v.trim() !== '')
      .map(([lineId, v]) => ({ lineId, receivedQtyMilli: Math.round(+v * 1000) }));
    if (await this.attempt(() => firstValueFrom(this.http.post(`/api/transfers/${t.id}/receive`, { lines })), 'Transfer received')) {
      this.receiving.set(null);
      this.arrived.set({});
    }
  }

  protected cancel(t: Transfer) {
    return this.attempt(() => firstValueFrom(this.http.post(`/api/transfers/${t.id}/cancel`, {})), 'Transfer cancelled; stock is back at the sender');
  }
}
