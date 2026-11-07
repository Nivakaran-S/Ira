import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { formatMinor } from '@pos/shared';
import { apiResource, humanMessage, toApiError, ToastService, UiBadge, UiEmpty } from 'ui';
import { BillingApi, type Invoice } from './billing-api';

/** Invoice table with mark-paid; used on its own page and on a tenant's page. */
@Component({
  selector: 'admin-invoice-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiEmpty],
  template: `
    @if (rows().length) {
      <table class="ui-table">
        <thead><tr><th>Invoice</th>@if (showTenant()) { <th>Tenant</th> }<th>Period</th><th>Due</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>
          @for (i of rows(); track i.id) {
            <tr [attr.data-invoice]="i.number">
              <td class="mono small">{{ i.number }}</td>
              @if (showTenant()) { <td>{{ i.tenant?.name }}</td> }
              <td class="small">{{ i.periodStart }} – {{ i.periodEnd }}</td>
              <td class="small">{{ i.dueOn }}</td>
              <td class="num">{{ i.currency }} {{ money(i.amount, i.currency) }}</td>
              <td><ui-badge [tone]="i.status === 'PAID' ? 'ok' : i.status === 'DUE' ? 'warn' : 'neutral'">{{ i.status }}</ui-badge> @if (i.paidRef) { <span class="small muted">{{ i.paidRef }}</span> }</td>
              <td>
                @if (i.status === 'DUE') {
                  <div class="row">
                    <input aria-label="Payment reference" placeholder="Reference" [value]="ref()[i.id] ?? ''" (input)="setRef(i.id, val($event))" style="max-width: 150px" />
                    <button class="btn small" type="button" [disabled]="(ref()[i.id] ?? '').trim().length < 2" (click)="pay(i)">Mark paid</button>
                  </div>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    } @else {
      <ui-empty title="No invoices" />
    }
  `,
  styles: `.num { text-align: right; }`,
})
export class InvoiceTable {
  private readonly api = inject(BillingApi);
  private readonly toasts = inject(ToastService);
  readonly rows = input.required<Invoice[]>();
  readonly showTenant = input(true);
  readonly changed = input<() => void>(() => undefined);
  protected readonly ref = signal<Record<string, string>>({});

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected money(n: number, c: string) {
    return formatMinor(n, c);
  }
  protected setRef(id: string, v: string) {
    this.ref.update((r) => ({ ...r, [id]: v }));
  }
  protected async pay(i: Invoice) {
    try {
      await this.api.pay(i.id, this.ref()[i.id].trim());
      this.toasts.success(`${i.number} marked paid`);
      this.changed()();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}

@Component({
  selector: 'admin-invoices',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InvoiceTable],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Invoices</h1>
        <div class="row">
          <select aria-label="Status" [value]="status()" (change)="status.set(val($event))">
            <option value="DUE">Due</option><option value="PAID">Paid</option><option value="">All</option>
          </select>
          <button class="btn" type="button" data-testid="run-billing" (click)="run()">Run billing now</button>
        </div>
      </div>
      <p class="small muted">Invoices are issued on the 1st of each month for paying plans and fall due a week later. Tenants unpaid past their plan's grace days are suspended until paid.</p>
      <section class="card flush"><admin-invoice-table [rows]="list.value() ?? []" [changed]="reload" /></section>
    </div>
  `,
})
export class Invoices {
  private readonly api = inject(BillingApi);
  private readonly toasts = inject(ToastService);
  protected readonly status = signal('DUE');
  protected readonly list = apiResource({ params: () => this.status(), loader: ({ params }) => this.api.invoices(params || undefined) });
  protected readonly reload = () => this.list.reload();

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected async run() {
    try {
      const r = await this.api.run();
      this.toasts.success(`${r.issued} invoices issued, ${r.suspended} tenants suspended`);
      this.list.reload();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
