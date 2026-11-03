import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { fieldErrors, humanMessage, toApiError, ToastService, UiEmpty, UiField } from 'ui';
import { BackofficeApi } from './backoffice-api';

@Component({
  selector: 'admin-registers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiEmpty, UiField],
  template: `
    <div class="page stack">
      <h1>Registers</h1>
      <section class="card flush">
        @if (registers.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Code</th><th>Name</th><th>Store</th></tr></thead>
            <tbody>
              @for (r of registers.value(); track r.id) {
                <tr><td class="mono">{{ r.code }}</td><td>{{ r.name }}</td><td>{{ storeName(r.storeId) }}</td></tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="registers.isLoading() ? 'Loading…' : 'No registers yet'" />
        }
      </section>
      <section class="card stack">
        <h2>Add a register</h2>
        @if (stores.value()?.length === 0) {
          <p class="muted">Add a store first.</p>
        } @else {
          <form class="row" style="align-items: flex-end" (submit)="$event.preventDefault(); add()">
            <ui-field label="Store" for="r-store">
              <select id="r-store" [value]="storeId()" (change)="storeId.set(val($event))">
                <option value="" disabled>Choose…</option>
                @for (s of stores.value() ?? []; track s.id) {
                  <option [value]="s.id">{{ s.code }} — {{ s.name }}</option>
                }
              </select>
            </ui-field>
            <ui-field label="Name" for="r-name" [error]="errors()['name']"><input id="r-name" [value]="name()" (input)="name.set(val($event))" /></ui-field>
            <ui-field label="Code" for="r-code" hint="1–6 capitals or digits" [error]="errors()['code']">
              <input id="r-code" [value]="code()" (input)="code.set(val($event).toUpperCase())" style="max-width: 120px" />
            </ui-field>
            <button class="btn primary" type="submit" [disabled]="!valid()">Add register</button>
          </form>
        }
      </section>
    </div>
  `,
})
export class Registers {
  private readonly api = inject(BackofficeApi);
  private readonly toasts = inject(ToastService);
  protected readonly registers = resource({ loader: () => this.api.registers() });
  protected readonly stores = resource({ loader: () => this.api.stores() });
  protected readonly storeId = signal('');
  protected readonly name = signal('');
  protected readonly code = signal('');
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly valid = computed(() => !!this.storeId() && !!this.name().trim() && /^[A-Z0-9]{1,6}$/.test(this.code()));

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected storeName(id: string) {
    return this.stores.value()?.find((s) => s.id === id)?.name ?? '—';
  }

  protected async add() {
    this.errors.set({});
    try {
      await this.api.createRegister({ storeId: this.storeId(), name: this.name().trim(), code: this.code() });
      this.toasts.success(`Register ${this.code()} added`);
      this.name.set('');
      this.code.set('');
      this.registers.reload();
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.toasts.error(err.code === 'CONFLICT' ? 'A register with that code already exists.' : humanMessage(err));
    }
  }
}
