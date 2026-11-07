import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import type { ModifierGroupDef } from '@pos/shared';
import { firstValueFrom } from 'rxjs';
import { apiResource, humanMessage, toApiError, ToastService, UiDialog, UiEmpty, UiField } from 'ui';
import { Money } from './money';

interface OptionDraft {
  id?: string;
  name: string;
  price: string;
  active: boolean;
}

/** Modifier groups (Size, Milk, Extras) and their options. Products pick groups in the catalog. */
@Component({
  selector: 'admin-modifiers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiDialog, UiEmpty, UiField],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Modifiers</h1>
        <button class="btn primary" type="button" data-testid="new-group" (click)="edit(null)">New group</button>
      </div>
      <section class="card flush">
        @if (groups.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>Group</th><th>Choose</th><th>Options</th><th></th></tr></thead>
            <tbody>
              @for (g of groups.value(); track g.id) {
                <tr [attr.data-group]="g.name">
                  <td>{{ g.name }}</td>
                  <td class="small">{{ g.minSelect }}–{{ g.maxSelect }}</td>
                  <td class="small">{{ describe(g) }}</td>
                  <td><button class="btn small" type="button" (click)="edit(g)">Edit</button></td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="groups.errorMessage() ?? (groups.isLoading() ? 'Loading…' : 'No modifier groups yet')" />
        }
      </section>
    </div>

    <ui-dialog [title]="editingId() ? 'Edit group' : 'New group'" [open]="open()" (closed)="open.set(false)">
      <form class="stack" data-testid="group-form" (submit)="$event.preventDefault(); save()">
        <ui-field label="Name" for="mg-name"><input id="mg-name" [value]="name()" (input)="name.set(val($event))" /></ui-field>
        <div class="grid-2">
          <ui-field label="Must choose at least" for="mg-min" hint="0 = optional"><input id="mg-min" inputmode="numeric" [value]="min()" (input)="min.set(val($event))" /></ui-field>
          <ui-field label="Can choose at most" for="mg-max"><input id="mg-max" inputmode="numeric" [value]="max()" (input)="max.set(val($event))" /></ui-field>
        </div>
        <strong>Options</strong>
        @for (o of options(); track $index; let i = $index) {
          <div class="row">
            <input [attr.aria-label]="'Option ' + (i + 1)" placeholder="Name" [value]="o.name" (input)="setOpt(i, { name: val($event) })" style="flex: 2" />
            <input [attr.aria-label]="'Price ' + (i + 1)" placeholder="+ price" inputmode="decimal" [value]="o.price" (input)="setOpt(i, { price: val($event) })" style="flex: 1" />
            <label class="check"><input type="checkbox" [checked]="o.active" (change)="setOpt(i, { active: checked($event) })" /> On</label>
          </div>
        }
        <div><button class="btn small" type="button" (click)="options.update((o) => [...o, { name: '', price: '', active: true }])">+ Option</button></div>
        <div><button class="btn primary" type="submit" [disabled]="!name().trim()">Save</button></div>
      </form>
    </ui-dialog>
  `,
  styles: `.check { display: flex; gap: 4px; align-items: center; }`,
})
export class Modifiers {
  private readonly http = inject(HttpClient);
  private readonly toasts = inject(ToastService);
  protected readonly money = inject(Money);
  protected readonly groups = apiResource({ loader: () => firstValueFrom(this.http.get<ModifierGroupDef[]>('/api/modifier-groups')) });
  protected readonly open = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly name = signal('');
  protected readonly min = signal('0');
  protected readonly max = signal('1');
  protected readonly options = signal<OptionDraft[]>([]);

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }
  protected checked(e: Event) {
    return (e.target as HTMLInputElement).checked;
  }
  protected describe(g: ModifierGroupDef) {
    return g.options
      .filter((o) => o.active)
      .map((o) => (o.priceDelta ? `${o.name} +${this.money.fmt(o.priceDelta)}` : o.name))
      .join(', ');
  }
  protected setOpt(i: number, patch: Partial<OptionDraft>) {
    this.options.update((list) => list.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  }

  protected edit(g: ModifierGroupDef | null) {
    this.editingId.set(g?.id ?? null);
    this.name.set(g?.name ?? '');
    this.min.set(String(g?.minSelect ?? 0));
    this.max.set(String(g?.maxSelect ?? 1));
    this.options.set(
      g ? g.options.map((o) => ({ id: o.id, name: o.name, price: o.priceDelta ? this.money.fmt(o.priceDelta).replace(/,/g, '') : '', active: o.active })) : [{ name: '', price: '', active: true }],
    );
    this.open.set(true);
  }

  protected async save() {
    const options = this.options()
      .filter((o) => o.name.trim())
      .map((o) => ({ ...(o.id ? { id: o.id } : {}), name: o.name.trim(), priceDelta: o.price.trim() ? (this.money.parse(o.price) ?? 0) : 0, active: o.active }));
    const body = { name: this.name().trim(), minSelect: Number(this.min()) || 0, maxSelect: Number(this.max()) || 1, options };
    const id = this.editingId();
    try {
      await firstValueFrom(id ? this.http.put(`/api/modifier-groups/${id}`, body) : this.http.post('/api/modifier-groups', body));
      this.toasts.success('Saved');
      this.open.set(false);
      this.groups.reload();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
