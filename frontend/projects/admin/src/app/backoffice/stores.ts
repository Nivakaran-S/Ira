import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { apiResource, fieldErrors, humanMessage, toApiError, ToastService, UiEmpty, UiField } from 'ui';
import { BackofficeApi } from './backoffice-api';

@Component({
  selector: 'admin-stores',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiEmpty, UiField],
  template: `
    <div class="page stack">
      <h1>Stores</h1>
      <section class="card flush">
        @if (stores.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Code</th><th>Name</th></tr></thead>
            <tbody>
              @for (s of stores.value(); track s.id) {
                <tr><td class="mono">{{ s.code }}</td><td>{{ s.name }}</td></tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="stores.errorMessage() ?? (stores.isLoading() ? 'Loading…' : 'No stores yet')" />
        }
      </section>
      <section class="card stack">
        <h2>Add a store</h2>
        <form class="row" style="align-items: flex-end" (submit)="$event.preventDefault(); add()">
          <ui-field label="Name" for="s-name" [error]="errors()['name']"><input id="s-name" [value]="name()" (input)="name.set(val($event))" /></ui-field>
          <ui-field label="Code" for="s-code" hint="2–8 capitals or digits" [error]="errors()['code']">
            <input id="s-code" [value]="code()" (input)="code.set(val($event).toUpperCase())" style="max-width: 140px" />
          </ui-field>
          <button class="btn primary" type="submit" [disabled]="!valid()">Add store</button>
        </form>
      </section>
    </div>
  `,
})
export class Stores {
  private readonly api = inject(BackofficeApi);
  private readonly toasts = inject(ToastService);
  protected readonly stores = apiResource({ loader: () => this.api.stores() });
  protected readonly name = signal('');
  protected readonly code = signal('');
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly valid = computed(() => !!this.name().trim() && /^[A-Z0-9]{2,8}$/.test(this.code()));

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async add() {
    this.errors.set({});
    try {
      await this.api.createStore({ name: this.name().trim(), code: this.code() });
      this.toasts.success(`Store ${this.code()} added`);
      this.name.set('');
      this.code.set('');
      this.stores.reload();
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.toasts.error(err.code === 'CONFLICT' ? 'A store with that code already exists.' : humanMessage(err));
    }
  }
}
