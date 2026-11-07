import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { humanMessage, toApiError } from 'ui';
import { PosApi, type TillCustomer } from '../api/pos-api';
import { TillState } from '../till-state';

/** Find a customer by phone or name, or add one. The till only ever sees name, last four digits and balances. */
@Component({
  selector: 'pos-customer-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack" data-testid="customer-picker">
      <form class="row" (submit)="$event.preventDefault(); search()">
        <input aria-label="Phone or name" placeholder="Phone number or name" data-testid="customer-q" [value]="q()" (input)="q.set(val($event))" style="flex: 1" />
        <button type="submit" class="btn primary" [disabled]="!q().trim() || busy()">Find</button>
      </form>
      @for (c of results(); track c.id) {
        <button type="button" class="btn pick" [attr.data-customer]="c.name" (click)="picked.emit(c)">
          <span>{{ c.name }} @if (c.phoneLast4) { <span class="muted">···{{ c.phoneLast4 }}</span> }</span>
          <span class="small muted">{{ c.points }} pts · credit {{ state.money(c.credit) }}</span>
        </button>
      }
      @if (searched() && !results().length) {
        <p class="muted">No match. Add them:</p>
        <div class="row">
          <input aria-label="New customer name" placeholder="Name" data-testid="new-customer-name" [value]="name()" (input)="name.set(val($event))" style="flex: 1" />
          <input aria-label="New customer phone" placeholder="Phone" data-testid="new-customer-phone" [value]="phone()" (input)="phone.set(val($event))" style="flex: 1" />
          <button type="button" class="btn" data-testid="add-customer" [disabled]="!name().trim() || busy()" (click)="create()">Add</button>
        </div>
      }
      @if (error()) {
        <div class="error-text" role="alert">{{ error() }}</div>
      }
    </div>
  `,
  styles: `.pick { justify-content: space-between; width: 100%; }`,
})
export class CustomerPicker {
  protected readonly state = inject(TillState);
  private readonly api = inject(PosApi);
  readonly picked = output<TillCustomer>();
  protected readonly q = signal('');
  protected readonly name = signal('');
  protected readonly phone = signal('');
  protected readonly results = signal<TillCustomer[]>([]);
  protected readonly searched = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async search() {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.results.set(await this.api.customers(this.q().trim()));
      this.searched.set(true);
      const q = this.q().trim();
      if (/^[+0-9 ()-]{7,}$/.test(q)) this.phone.set(q);
      else this.name.set(q);
    } catch (e) {
      this.error.set(humanMessage(toApiError(e)));
    } finally {
      this.busy.set(false);
    }
  }

  protected async create() {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.picked.emit(await this.api.createCustomer({ name: this.name().trim(), ...(this.phone().trim() ? { phone: this.phone().trim() } : {}) }));
    } catch (e) {
      const err = toApiError(e);
      this.error.set(err.code === 'CONFLICT' ? 'A customer with that phone number already exists. Search for it.' : humanMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
