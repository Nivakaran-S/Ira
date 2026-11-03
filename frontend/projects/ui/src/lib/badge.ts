import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'ui-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'tone()' },
  template: `<ng-content />`,
  styles: `
    :host { display: inline-block; padding: 2px var(--s2); border-radius: 999px; font-size: 12px; font-weight: 600; background: var(--surface-2); color: var(--text-2); border: 1px solid var(--border); }
    :host(.ok) { background: var(--ok-soft); color: var(--ok); border-color: #b4dfbf; }
    :host(.warn) { background: var(--warn-soft); color: var(--warn); border-color: #f1d48a; }
    :host(.danger) { background: var(--danger-soft); color: var(--danger); border-color: #f4b8b2; }
    :host(.accent) { background: var(--accent-soft); color: var(--accent); border-color: #b7ded9; }
  `,
})
export class UiBadge {
  readonly tone = input<'neutral' | 'ok' | 'warn' | 'danger' | 'accent'>('neutral');
}
