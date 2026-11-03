import { ChangeDetectionStrategy, Component, effect, input, signal } from '@angular/core';
import { toDataURL } from 'qrcode';

/** Renders a QR code for a value (e.g. an otpauth:// URL) entirely in the browser. */
@Component({
  selector: 'ui-qr',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (src()) {
      <img [src]="src()" [alt]="alt()" width="200" height="200" />
    }
  `,
  styles: `img { display: block; border: 1px solid var(--border); border-radius: var(--radius); background: #fff; }`,
})
export class UiQr {
  readonly value = input.required<string>();
  readonly alt = input('QR code');
  protected readonly src = signal<string | null>(null);

  constructor() {
    effect(() => {
      toDataURL(this.value(), { width: 200, margin: 1, errorCorrectionLevel: 'M' }).then(
        (url) => this.src.set(url),
        () => this.src.set(null),
      );
    });
  }
}
