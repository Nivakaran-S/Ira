import { HttpClient } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiDialog, UiEmpty, UiField } from 'ui';
import { BackofficeApi } from './backoffice-api';
import { CommerceApi } from './commerce-api';
import { Money } from './money';

interface Lot {
  id: string;
  productId: string;
  productName: string;
  lotNo: string;
  expiresOn: string;
  qtyMilli: number;
  expired: boolean;
  expiringSoon: boolean;
}
interface Recall {
  lot: { lotNo: string; expiresOn: string };
  sales: { saleId: string; receiptNo: string; soldAt: string; customerId: string | null; name: string }[];
}

/** Lots by expiry: receive stock into a lot, see what has expired or soon will, and trace a lot's sales. */
@Component({
  selector: 'admin-batches',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, UiBadge, UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Lots and expiry</h1>
        <select aria-label="Store" [value]="storeId()" (change)="storeId.set(val($event))" style="max-width: 260px">
          @for (s of stores.value() ?? []; track s.id) { <option [value]="s.id">{{ s.code }} · {{ s.name }}</option> }
        </select>
      </div>
      <section class="card stack">
        <h2>Receive stock</h2>
        <form class="row" style="align-items: flex-end" (submit)="$event.preventDefault(); receive()">
          <ui-field label="Product" for="b-prod">
            <select id="b-prod" [value]="productId()" (change)="productId.set(val($event))">
              <option value="">Choose…</option>
              @for (p of lotProducts(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
            </select>
          </ui-field>
          <ui-field label="Lot number" for="b-lot"><input id="b-lot" [value]="lotNo()" (input)="lotNo.set(val($event))" style="max-width: 140px" /></ui-field>
          <ui-field label="Expires" for="b-exp"><input id="b-exp" type="date" [value]="expiresOn()" (input)="expiresOn.set(val($event))" /></ui-field>
          <ui-field label="Quantity" for="b-qty"><input id="b-qty" inputmode="decimal" [value]="qty()" (input)="qty.set(val($event))" style="max-width: 100px" /></ui-field>
          <button class="btn primary" type="submit" [disabled]="!productId() || !lotNo().trim() || !expiresOn() || !(+qty() > 0)">Receive</button>
        </form>
      </section>
      <section class="card flush">
        @if (lots.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Product</th><th>Lot</th><th>Expires</th><th class="num">On hand</th><th></th></tr></thead>
            <tbody>
              @for (l of lots.value(); track l.id) {
                <tr [attr.data-lot]="l.lotNo">
                  <td>{{ l.productName }}</td>
                  <td class="mono">{{ l.lotNo }}</td>
                  <td>
                    {{ l.expiresOn | date: 'mediumDate' }}
                    @if (l.expired) { <ui-badge tone="danger">Expired</ui-badge> } @else if (l.expiringSoon) { <ui-badge tone="warn">Soon</ui-badge> }
                  </td>
                  <td class="num">{{ money.qty(l.qtyMilli) }}</td>
                  <td><button class="btn small" type="button" (click)="recall(l.id)">Who bought it</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="lots.errorMessage() ?? (lots.isLoading() ? 'Loading…' : 'No lots in stock')" />
        }
      </section>
    </div>

    <ui-dialog [title]="'Lot ' + (traced()?.lot?.lotNo ?? '')" [open]="!!traced()" (closed)="traced.set(null)">
      @if (traced(); as t) {
        @for (s of t.sales; track s.saleId) {
          <div class="row-between small"><span class="mono">{{ s.receiptNo }}</span><span>{{ s.soldAt | date: 'short' }}</span><span>{{ s.customerId ? 'Customer on file' : 'Walk-in' }}</span></div>
        } @empty { <p class="muted">Nothing sold from this lot.</p> }
      }
    </ui-dialog>
  `,
  styles: `.num { text-align: right; }`,
})
export class Batches {
  private readonly http = inject(HttpClient);
  private readonly bo = inject(BackofficeApi);
  private readonly commerce = inject(CommerceApi);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly stores = apiResource({
    loader: async () => {
      const list = await this.bo.stores();
      if (!this.storeId() && list[0]) this.storeId.set(list[0].id);
      return list;
    },
  });
  protected readonly storeId = signal('');
  protected readonly lots = apiResource({
    params: () => this.storeId() || undefined,
    loader: ({ params }) => firstValueFrom(this.http.get<Lot[]>(`/api/batches?storeId=${params}`)),
  });
  private readonly products = apiResource({ loader: () => this.commerce.products(false) });
  protected readonly lotProducts = computed(() => (this.products.value() ?? []).filter((p) => (p as { tracksBatches?: boolean }).tracksBatches));
  protected readonly productId = signal('');
  protected readonly lotNo = signal('');
  protected readonly expiresOn = signal('');
  protected readonly qty = signal('');
  protected readonly traced = signal<Recall | null>(null);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async receive() {
    try {
      await firstValueFrom(
        this.http.post('/api/batches/receive', {
          storeId: this.storeId(), productId: this.productId(), lotNo: this.lotNo().trim(), expiresOn: this.expiresOn(), qtyMilli: Math.round(Number(this.qty()) * 1000),
        }),
      );
      this.toasts.success(`Lot ${this.lotNo().trim()} received`);
      this.lotNo.set('');
      this.qty.set('');
      this.lots.reload();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }

  protected async recall(id: string) {
    try {
      this.traced.set(await firstValueFrom(this.http.get<Recall>(`/api/batches/${id}/sales`)));
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
