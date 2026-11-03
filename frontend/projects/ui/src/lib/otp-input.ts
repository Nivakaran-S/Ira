import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

/** Six-digit one-time code entry. Digits only; emits `completed` once six are present. */
@Component({
  selector: 'ui-otp-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <input
      class="otp"
      [id]="inputId()"
      inputmode="numeric"
      autocomplete="one-time-code"
      maxlength="6"
      placeholder="000000"
      [attr.aria-label]="label()"
      [value]="value()"
      (input)="onInput($event)"
    />
  `,
  styles: `
    .otp { font-family: var(--font-mono); font-size: 24px; letter-spacing: 0.4em; text-align: center; max-width: 220px; }
  `,
})
export class UiOtpInput {
  readonly label = input('Six-digit code');
  readonly inputId = input('otp');
  readonly completed = output<string>();
  protected readonly value = signal('');

  protected onInput(event: Event) {
    const el = event.target as HTMLInputElement;
    const digits = el.value.replace(/\D/g, '').slice(0, 6);
    el.value = digits;
    this.value.set(digits);
    if (digits.length === 6) this.completed.emit(digits);
  }

  clear() {
    this.value.set('');
  }
}
