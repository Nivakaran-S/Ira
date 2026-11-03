import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'ui-empty',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p class="title">{{ title() }}</p><ng-content />`,
  styles: `
    :host { display: block; text-align: center; padding: var(--s6) var(--s4); color: var(--text-3); }
    .title { font-weight: 600; color: var(--text-2); }
  `,
})
export class UiEmpty {
  readonly title = input.required<string>();
}
