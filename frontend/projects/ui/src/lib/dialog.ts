import { ChangeDetectionStrategy, Component, effect, type ElementRef, input, output, viewChild } from '@angular/core';

/** Native <dialog> as a modal. Control with [open]; (closed) fires on Esc or the close button. */
@Component({
  selector: 'ui-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dlg (close)="closed.emit()" [attr.aria-label]="title()">
      <header class="row-between">
        <h2>{{ title() }}</h2>
        <button type="button" class="btn ghost small" aria-label="Close" (click)="dlg.close()">×</button>
      </header>
      <ng-content />
    </dialog>
  `,
  styles: `
    dialog { border: none; border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--s5); width: min(560px, calc(100vw - 32px)); }
    dialog::backdrop { background: rgb(16 24 40 / 45%); }
    header { margin-bottom: var(--s4); }
    h2 { margin: 0; }
  `,
})
export class UiDialog {
  readonly title = input.required<string>();
  readonly open = input(false);
  readonly closed = output<void>();
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const el = this.dlg().nativeElement;
      if (this.open() && !el.open) el.showModal?.();
      if (!this.open() && el.open) el.close();
    });
  }
}
