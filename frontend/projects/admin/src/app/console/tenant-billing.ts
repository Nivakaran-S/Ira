import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { apiResource, humanMessage, toApiError, ToastService } from 'ui';
import { BillingApi } from './billing-api';
import { InvoiceTable } from './invoices';

/** A tenant's plan, usage against its limits, and invoices, on the tenant page. */
@Component({
  selector: 'admin-tenant-billing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InvoiceTable],
  template: `
    <section class="card stack" data-testid="tenant-billing">
      <div class="row-between">
        <h2>Plan and billing</h2>
        <select aria-label="Plan" [value]="billing.value()?.plan?.key ?? ''" (change)="change(val($event))" style="max-width: 240px">
          @for (p of plans.value() ?? []; track p.key) { <option [value]="p.key">{{ p.name }}</option> }
        </select>
      </div>
      @if (billing.value(); as b) {
        <div class="usage">
          @for (k of keys; track k) {
            <div><div class="small muted">{{ k }}</div><strong>{{ b.usage[k] }} / {{ b.limits[k] }}</strong></div>
          }
        </div>
        <admin-invoice-table [rows]="b.invoices" [showTenant]="false" [changed]="reload" />
      }
    </section>
  `,
  styles: `.usage { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s3); }`,
})
export class TenantBillingPanel {
  private readonly api = inject(BillingApi);
  private readonly toasts = inject(ToastService);
  readonly tenantId = input.required<string>();
  protected readonly keys = ['stores', 'devices', 'users', 'products'] as const;
  protected readonly plans = apiResource({ loader: () => this.api.plans() });
  protected readonly billing = apiResource({ params: () => this.tenantId(), loader: ({ params }) => this.api.tenantBilling(params) });
  protected readonly reload = () => this.billing.reload();

  protected val(e: Event) {
    return (e.target as HTMLSelectElement).value;
  }
  protected async change(key: string) {
    try {
      await this.api.changePlan(this.tenantId(), key);
      this.toasts.success('Plan changed');
      this.billing.reload();
    } catch (e) {
      const err = toApiError(e);
      const over = (err.details as { over?: string[] } | undefined)?.over;
      this.toasts.error(over ? `The tenant uses more than that plan allows: ${over.join(', ')}` : humanMessage(err));
      this.billing.reload();
    }
  }
}
