import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { apiResource, fieldErrors, humanMessage, toApiError, ToastService, UiDialog, UiEmpty, UiField } from 'ui';
import { RetailApi } from './retail-api';

@Component({
  selector: 'admin-customers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Customers</h1>
        <button class="btn primary" type="button" data-testid="new-customer" (click)="open.set(true)">New customer</button>
      </div>
      <form class="row" (submit)="$event.preventDefault(); list.reload()">
        <input aria-label="Search customers" placeholder="Phone number or name" [value]="q()" (input)="q.set(val($event))" style="max-width: 320px" />
        <button class="btn" type="submit">Search</button>
      </form>
      <p class="small muted">Phone numbers and emails are stored encrypted. Search finds an exact phone number or part of a name.</p>
      <section class="card flush">
        @if (list.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Name</th><th>Phone</th><th>Added</th><th></th></tr></thead>
            <tbody>
              @for (c of list.value(); track c.id) {
                <tr [attr.data-customer]="c.name">
                  <td>{{ c.name }}</td>
                  <td class="mono small">{{ c.phone ?? (c.phoneLast4 ? '···' + c.phoneLast4 : '—') }}</td>
                  <td class="small">{{ c.createdAt | date: 'mediumDate' }}</td>
                  <td><a class="btn small" [routerLink]="['/customers', c.id]">Open</a></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="list.errorMessage() ?? (list.isLoading() ? 'Loading…' : 'No customers')" />
        }
      </section>
    </div>

    <ui-dialog title="New customer" [open]="open()" (closed)="open.set(false)">
      <form class="stack" (submit)="$event.preventDefault(); create()">
        <ui-field label="Name" for="c-name" [error]="errors()['name']"><input id="c-name" [value]="name()" (input)="name.set(val($event))" /></ui-field>
        <ui-field label="Phone" for="c-phone" [error]="errors()['phone']"><input id="c-phone" [value]="phone()" (input)="phone.set(val($event))" /></ui-field>
        <ui-field label="Email" for="c-email" [error]="errors()['email']"><input id="c-email" type="email" [value]="email()" (input)="email.set(val($event))" /></ui-field>
        <div><button class="btn primary" type="submit" [disabled]="!name().trim()">Save</button></div>
      </form>
    </ui-dialog>
  `,
})
export class Customers {
  private readonly api = inject(RetailApi);
  private readonly toasts = inject(ToastService);
  protected readonly q = signal('');
  protected readonly list = apiResource({ loader: () => this.api.customers(this.q().trim()) });
  protected readonly open = signal(false);
  protected readonly name = signal('');
  protected readonly phone = signal('');
  protected readonly email = signal('');
  protected readonly errors = signal<Record<string, string>>({});

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async create() {
    this.errors.set({});
    try {
      await this.api.createCustomer({
        name: this.name().trim(),
        ...(this.phone().trim() ? { phone: this.phone().trim() } : {}),
        ...(this.email().trim() ? { email: this.email().trim() } : {}),
      });
      this.toasts.success('Customer added');
      this.open.set(false);
      this.name.set('');
      this.phone.set('');
      this.email.set('');
      this.list.reload();
    } catch (e) {
      const err = toApiError(e);
      this.errors.set(fieldErrors(err));
      this.toasts.error(err.code === 'CONFLICT' ? 'A customer with that phone number already exists.' : humanMessage(err));
    }
  }
}
