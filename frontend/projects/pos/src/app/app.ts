import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { UiToastHost } from 'ui';

@Component({
  selector: 'pos-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, UiToastHost],
  template: `<router-outlet /><ui-toast-host />`,
})
export class App {}
