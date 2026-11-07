import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import type { CatalogProduct } from '../api/pos-api';
import { HardwareBridge } from '../hardware/bridge';
import { TillState } from '../till-state';

/** Weight for a sold-by-weight item: from the scale through the bridge, or typed in. */
@Component({
  selector: 'pos-weigh',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack" data-testid="weigh">
      <div class="muted">{{ state.money(product().price) }} per kg</div>
      <div class="row">
        <button type="button" class="btn" data-testid="read-scale" [disabled]="reading()" (click)="read()">Read scale</button>
        <label class="grow">Weight (kg)<input inputmode="decimal" data-testid="weight-kg" [value]="kg()" (input)="kg.set(val($event))" /></label>
      </div>
      @if (note()) {
        <div class="small muted">{{ note() }}</div>
      }
      <div class="row-between">
        <strong>{{ grams() ? state.money(price()) : '' }}</strong>
        <button type="button" class="btn primary" data-testid="weigh-add" [disabled]="!grams()" (click)="weighed.emit(grams())">Add {{ grams() ? state.qty(grams()) + ' kg' : '' }}</button>
      </div>
    </div>
  `,
  styles: `label { display: flex; flex-direction: column; gap: 4px; font-weight: 550; } .grow { flex: 1; }`,
})
export class Weigh implements OnInit {
  protected readonly state = inject(TillState);
  private readonly bridge = inject(HardwareBridge);
  readonly product = input.required<CatalogProduct>();
  readonly weighed = output<number>();
  protected readonly kg = signal('');
  protected readonly reading = signal(false);
  protected readonly note = signal<string | null>(null);
  /** Grams, i.e. thousandths of a kilo: the quantity unit sales use. */
  protected readonly grams = computed(() => {
    const n = Number(this.kg().replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0;
  });
  protected readonly price = computed(() => Math.round((this.product().price * this.grams()) / 1000));

  ngOnInit() {
    void this.read();
  }

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected async read() {
    this.reading.set(true);
    const w = await this.bridge.weigh();
    this.reading.set(false);
    if (!w) return this.note.set('No scale connected: type the weight.');
    this.kg.set((w.grams / 1000).toString());
    this.note.set(w.stable ? null : 'The scale was still settling. Read again if needed.');
  }
}
