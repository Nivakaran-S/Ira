import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

const MIN = 4;
const MAX = 8;

/** Touch keypad for a 4–8 digit PIN. Digits are never rendered, only dots. Physical keyboards work too. */
@Component({
  selector: 'pos-pin-pad',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onKey($event)' },
  template: `
    <div class="dots" [attr.aria-label]="digits().length + ' digits entered'" role="status">
      @for (i of slots(); track i) {
        <span class="dot" [class.filled]="i < digits().length"></span>
      }
    </div>
    <div class="keys">
      @for (k of keys; track k) {
        <button type="button" class="key" (click)="add(k)" [disabled]="disabled()">{{ k }}</button>
      }
      <button type="button" class="key aux" aria-label="Delete last digit" (click)="back()" [disabled]="disabled()">⌫</button>
      <button type="button" class="key" (click)="add('0')" [disabled]="disabled()">0</button>
      <button type="button" class="key enter" aria-label="Enter" (click)="submit()" [disabled]="disabled() || digits().length < min">Enter</button>
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; align-items: center; gap: var(--s5); }
    .dots { display: flex; gap: var(--s3); min-height: 20px; }
    .dot { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border-strong); }
    .dot.filled { background: var(--text); border-color: var(--text); }
    .keys { display: grid; grid-template-columns: repeat(3, 84px); gap: var(--s3); }
    .key { height: 72px; font: inherit; font-size: 26px; font-weight: 600; border-radius: var(--radius-lg); border: 1px solid var(--border-strong); background: var(--surface); cursor: pointer; touch-action: manipulation; }
    .key:active:not(:disabled) { background: var(--surface-2); }
    .key.aux { font-size: 22px; }
    .key.enter { font-size: 17px; background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
    .key:disabled { opacity: 0.45; }
  `,
})
export class PinPad {
  readonly disabled = input(false);
  readonly submitted = output<string>();
  protected readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  protected readonly min = MIN;
  protected readonly digits = signal('');
  protected readonly slots = computed(() => Array.from({ length: Math.max(MIN, this.digits().length) }, (_, i) => i));

  protected add(d: string) {
    if (this.digits().length < MAX) this.digits.update((v) => v + d);
  }
  protected back() {
    this.digits.update((v) => v.slice(0, -1));
  }
  protected submit() {
    if (this.digits().length >= MIN && !this.disabled()) this.submitted.emit(this.digits());
  }
  protected onKey(e: KeyboardEvent) {
    if (this.disabled()) return;
    if (/^\d$/.test(e.key)) this.add(e.key);
    else if (e.key === 'Backspace') this.back();
    else if (e.key === 'Enter') this.submit();
  }

  clear() {
    this.digits.set('');
  }
}
