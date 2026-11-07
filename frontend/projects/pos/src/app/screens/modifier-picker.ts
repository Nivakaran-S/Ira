import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { chooseModifiers } from '@pos/shared';
import type { CatalogProduct, ChosenModifier } from '../api/pos-api';
import { TillState } from '../till-state';

/** Pick options for an item, group by group; the same rules the API checks. */
@Component({
  selector: 'pos-modifier-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack" data-testid="modifier-picker">
      @for (g of product().modifierGroups ?? []; track g.id) {
        <section class="stack group">
          <div class="row-between">
            <strong>{{ g.name }}</strong>
            <span class="small muted">{{ g.minSelect ? (g.minSelect === g.maxSelect ? 'Choose ' + g.minSelect : 'Choose ' + g.minSelect + '-' + g.maxSelect) : 'Optional, up to ' + g.maxSelect }}</span>
          </div>
          <div class="opts">
            @for (o of g.options; track o.id) {
              @if (o.active) {
                <button type="button" class="opt" [class.on]="picked().includes(o.id)" [attr.data-option]="o.name" (click)="toggle(g.id, o.id, g.maxSelect)">
                  <span>{{ o.name }}</span>
                  @if (o.priceDelta) { <span class="small">+{{ state.money(o.priceDelta) }}</span> }
                </button>
              }
            }
          </div>
        </section>
      }
      @if (problem()) {
        <div class="small muted">{{ problem() }}</div>
      }
      <div class="row-between">
        <strong>{{ state.money(price()) }}</strong>
        <button type="button" class="btn primary" data-testid="modifiers-done" [disabled]="!!problem()" (click)="confirm()">Add</button>
      </div>
    </div>
  `,
  styles: `
    .opts { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: var(--s2); }
    .opt { display: flex; flex-direction: column; align-items: flex-start; padding: var(--s3); border-radius: var(--radius); border: 2px solid var(--border); background: var(--surface); font: inherit; cursor: pointer; }
    .opt.on { border-color: var(--accent); background: var(--accent-soft); }
  `,
})
export class ModifierPicker {
  protected readonly state = inject(TillState);
  readonly product = input.required<CatalogProduct>();
  readonly chosen = output<ChosenModifier[]>();
  protected readonly picked = signal<string[]>([]);
  private readonly result = computed(() => chooseModifiers(this.product().modifierGroups ?? [], this.picked()));
  protected readonly problem = computed(() => {
    const r = this.result();
    return r.ok ? null : r.reason;
  });
  protected readonly price = computed(() => {
    const r = this.result();
    return this.product().price + (r.ok ? r.chosen.reduce((s, m) => s + m.priceDelta, 0) : 0);
  });

  /** Single-choice groups swap the selection; multi-choice groups toggle up to their maximum. */
  protected toggle(groupId: string, optionId: string, max: number) {
    const group = (this.product().modifierGroups ?? []).find((g) => g.id === groupId)!;
    const inGroup = new Set(group.options.map((o) => o.id));
    this.picked.update((ids) => {
      if (ids.includes(optionId)) return ids.filter((x) => x !== optionId);
      const others = ids.filter((x) => inGroup.has(x));
      if (max === 1) return [...ids.filter((x) => !inGroup.has(x)), optionId];
      return others.length >= max ? ids : [...ids, optionId];
    });
  }

  protected confirm() {
    const r = this.result();
    if (r.ok) this.chosen.emit(r.chosen.map((c) => ({ id: c.id, name: c.name, priceDelta: c.priceDelta })));
  }
}
