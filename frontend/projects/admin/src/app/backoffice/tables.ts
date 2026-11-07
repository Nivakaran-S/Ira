import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { apiResource, humanMessage, toApiError, ToastService, UiEmpty, UiField } from 'ui';
import { BackofficeApi } from './backoffice-api';

interface DiningTable {
  id: string;
  storeId: string;
  name: string;
  area: string | null;
  seats: number;
  active: boolean;
}

@Component({
  selector: 'admin-tables',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiEmpty, UiField],
  template: `
    <div class="page stack">
      <h1>Tables</h1>
      <section class="card flush">
        @if (tables.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Store</th><th>Table</th><th>Area</th><th>Seats</th></tr></thead>
            <tbody>
              @for (t of tables.value(); track t.id) {
                <tr><td>{{ storeName(t.storeId) }}</td><td>{{ t.name }}</td><td>{{ t.area ?? '' }}</td><td>{{ t.seats }}</td></tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="tables.errorMessage() ?? (tables.isLoading() ? 'Loading…' : 'No tables yet')" />
        }
      </section>
      <section class="card stack">
        <h2>Add a table</h2>
        <form class="row" style="align-items: flex-end" (submit)="$event.preventDefault(); add()">
          <ui-field label="Store" for="t-store">
            <select id="t-store" [value]="storeId()" (change)="storeId.set(val($event))">
              @for (s of stores.value() ?? []; track s.id) { <option [value]="s.id">{{ s.code }} · {{ s.name }}</option> }
            </select>
          </ui-field>
          <ui-field label="Table" for="t-name"><input id="t-name" [value]="name()" (input)="name.set(val($event))" style="max-width: 120px" /></ui-field>
          <ui-field label="Area" for="t-area"><input id="t-area" [value]="area()" (input)="area.set(val($event))" style="max-width: 160px" /></ui-field>
          <ui-field label="Seats" for="t-seats"><input id="t-seats" inputmode="numeric" [value]="seats()" (input)="seats.set(val($event))" style="max-width: 80px" /></ui-field>
          <button class="btn primary" type="submit" [disabled]="!name().trim() || !storeId()">Add table</button>
        </form>
      </section>
    </div>
  `,
})
export class Tables {
  private readonly http = inject(HttpClient);
  private readonly bo = inject(BackofficeApi);
  private readonly toasts = inject(ToastService);
  protected readonly stores = apiResource({
    loader: async () => {
      const list = await this.bo.stores();
      if (!this.storeId() && list[0]) this.storeId.set(list[0].id);
      return list;
    },
  });
  protected readonly tables = apiResource({ loader: () => firstValueFrom(this.http.get<DiningTable[]>('/api/tables')) });
  protected readonly storeId = signal('');
  protected readonly name = signal('');
  protected readonly area = signal('');
  protected readonly seats = signal('4');

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected storeName(id: string) {
    return this.stores.value()?.find((s) => s.id === id)?.code ?? '';
  }

  protected async add() {
    try {
      await firstValueFrom(
        this.http.post('/api/tables', { storeId: this.storeId(), name: this.name().trim(), ...(this.area().trim() ? { area: this.area().trim() } : {}), seats: Number(this.seats()) || 2 }),
      );
      this.toasts.success(`Table ${this.name().trim()} added`);
      this.name.set('');
      this.tables.reload();
    } catch (e) {
      const err = toApiError(e);
      this.toasts.error(err.code === 'CONFLICT' ? 'That table name is already used in this store.' : humanMessage(err));
    }
  }
}
