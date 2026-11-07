import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { humanMessage, toApiError } from 'ui';
import type { CatalogProduct, TillCustomer } from '../api/pos-api';
import { TillState } from '../till-state';

interface Prescription {
  id: string;
  prescriber: string;
  prescriberRegNo: string | null;
  issuedOn: string;
  items: { id: string; productId: string; qtyMilli: number; dispensedQtyMilli: number; directions: string | null }[];
}

/** Dispense against one of the customer's prescriptions, or record the one they brought. */
@Component({
  selector: 'pos-prescription-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack" data-testid="rx-picker">
      <div class="muted">{{ product().name }} needs a prescription for {{ customer().name }}.</div>
      @for (o of options(); track o.itemId) {
        <button type="button" class="btn pick" [attr.data-rx]="o.prescriber" (click)="picked.emit({ itemId: o.itemId, qtyMilli: Math.min(1000, o.left) })">
          <span>{{ o.prescriber }} · {{ o.issuedOn }}</span>
          <span class="small">{{ state.qty(o.left) }} left {{ o.directions ? '· ' + o.directions : '' }}</span>
        </button>
      }
      @if (!loading() && !options().length) {
        <p class="muted">No prescription on file for this medicine.</p>
      }
      <details [open]="!options().length">
        <summary>Record a new prescription</summary>
        <div class="stack form">
          <label>Prescriber<input data-testid="rx-prescriber" [value]="prescriber()" (input)="prescriber.set(val($event))" /></label>
          <label>Registration no.<input [value]="regNo()" (input)="regNo.set(val($event))" /></label>
          <div class="row">
            <label class="grow">Issued on<input type="date" data-testid="rx-date" [value]="issuedOn()" (input)="issuedOn.set(val($event))" /></label>
            <label class="grow">Quantity<input inputmode="numeric" data-testid="rx-qty" [value]="qty()" (input)="qty.set(val($event))" /></label>
          </div>
          <label>Directions<input [value]="directions()" (input)="directions.set(val($event))" /></label>
          <button type="button" class="btn primary" data-testid="rx-save" [disabled]="!prescriber().trim() || !issuedOn() || !(+qty() > 0)" (click)="record()">Save and dispense</button>
        </div>
      </details>
      @if (error()) {
        <div class="error-text" role="alert">{{ error() }}</div>
      }
    </div>
  `,
  styles: `.pick { justify-content: space-between; width: 100%; } label { display: flex; flex-direction: column; gap: 4px; } .grow { flex: 1; } .form { margin-top: var(--s2); }`,
})
export class PrescriptionPicker implements OnInit {
  protected readonly state = inject(TillState);
  private readonly http = inject(HttpClient);
  protected readonly Math = Math;
  readonly product = input.required<CatalogProduct>();
  readonly customer = input.required<TillCustomer>();
  readonly picked = output<{ itemId: string; qtyMilli: number }>();
  private readonly list = signal<Prescription[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly prescriber = signal('');
  protected readonly regNo = signal('');
  protected readonly issuedOn = signal(new Date().toISOString().slice(0, 10));
  protected readonly qty = signal('1');
  protected readonly directions = signal('');

  protected readonly options = computed(() =>
    this.list().flatMap((rx) =>
      rx.items
        .filter((i) => i.productId === this.product().id && i.qtyMilli > i.dispensedQtyMilli)
        .map((i) => ({ itemId: i.id, prescriber: rx.prescriber, issuedOn: rx.issuedOn, left: i.qtyMilli - i.dispensedQtyMilli, directions: i.directions })),
    ),
  );

  async ngOnInit() {
    try {
      this.list.set(await firstValueFrom(this.http.get<Prescription[]>(`/api/pos/prescriptions?customerId=${this.customer().id}`)));
    } catch (e) {
      this.error.set(humanMessage(toApiError(e)));
    } finally {
      this.loading.set(false);
    }
  }

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async record() {
    this.error.set(null);
    try {
      const rx = await firstValueFrom(
        this.http.post<Prescription>('/api/pos/prescriptions', {
          customerId: this.customer().id,
          prescriber: this.prescriber().trim(),
          ...(this.regNo().trim() ? { prescriberRegNo: this.regNo().trim() } : {}),
          issuedOn: this.issuedOn(),
          items: [{ productId: this.product().id, qtyMilli: Math.round(Number(this.qty()) * 1000), ...(this.directions().trim() ? { directions: this.directions().trim() } : {}) }],
        }),
      );
      this.picked.emit({ itemId: rx.items[0].id, qtyMilli: Math.min(1000, rx.items[0].qtyMilli) });
    } catch (e) {
      const err = toApiError(e);
      this.error.set(err.code === 'FORBIDDEN' ? 'Only a pharmacist can record prescriptions.' : humanMessage(err));
    }
  }
}
