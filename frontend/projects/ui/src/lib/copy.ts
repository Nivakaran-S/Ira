import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

/** A value shown in monospace with a copy button. Used for one-time codes and TXT records. */
@Component({
  selector: 'ui-copy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="value" [class.large]="large()" data-testid="copy-value">{{ value() }}</span>
    <button type="button" class="copy" (click)="copy()">{{ copied() ? 'Copied' : 'Copy' }}</button>
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: var(--s2); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s1) var(--s1) var(--s1) var(--s3); max-width: 100%; }
    .value { font-family: var(--font-mono); word-break: break-all; }
    .value.large { font-size: 28px; letter-spacing: 0.12em; font-weight: 600; }
    .copy { font: inherit; font-size: 13px; border: 1px solid var(--border-strong); background: var(--surface); border-radius: 6px; padding: var(--s1) var(--s3); cursor: pointer; }
  `,
})
export class UiCopy {
  readonly value = input.required<string>();
  readonly large = input(false);
  protected readonly copied = signal(false);

  async copy() {
    try {
      await navigator.clipboard.writeText(this.value());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.copied.set(false);
    }
  }
}
