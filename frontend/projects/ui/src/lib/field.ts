import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Label + projected native control + hint/error. Pass the control's id as `for`. */
@Component({
  selector: 'ui-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label [attr.for]="for()">{{ label() }}</label>
    <ng-content />
    @if (error()) {
      <div class="error-text" role="alert">{{ error() }}</div>
    } @else if (hint()) {
      <div class="muted small">{{ hint() }}</div>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: var(--s1); }
    label { font-weight: 550; font-size: 14px; }
  `,
})
export class UiField {
  readonly label = input.required<string>();
  readonly for = input<string>();
  readonly hint = input<string>();
  readonly error = input<string | null | undefined>();
}
