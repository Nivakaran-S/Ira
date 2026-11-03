import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** App frame: sidebar (brand + projected [nav] and [foot]) and a main area with projected [banner] and [toolbar]. */
@Component({
  selector: 'ui-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aside>
      <div class="brand">
        <span class="mark" aria-hidden="true">◆</span>
        <div>
          <div class="name">{{ brand() }}</div>
          @if (subtitle()) {
            <div class="sub">{{ subtitle() }}</div>
          }
        </div>
      </div>
      <nav><ng-content select="[nav]" /></nav>
      <div class="foot"><ng-content select="[foot]" /></div>
    </aside>
    <div class="main">
      <ng-content select="[banner]" />
      <header><ng-content select="[toolbar]" /></header>
      <main><ng-content /></main>
    </div>
  `,
  styles: `
    :host { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
    aside { background: #111827; color: #e5e7eb; display: flex; flex-direction: column; padding: var(--s4) var(--s3); position: sticky; top: 0; height: 100vh; }
    .brand { display: flex; gap: var(--s3); align-items: center; padding: var(--s2) var(--s2) var(--s5); }
    .mark { color: #5eead4; font-size: 20px; }
    .name { font-weight: 650; }
    .sub { font-size: 12px; color: #9ca3af; overflow-wrap: anywhere; }
    nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    nav ::ng-deep a { color: #d1d5db; text-decoration: none; padding: var(--s2) var(--s3); border-radius: var(--radius); font-weight: 500; }
    nav ::ng-deep a:hover { background: #1f2937; color: #fff; }
    nav ::ng-deep a.active { background: #134e4a; color: #fff; }
    .foot { border-top: 1px solid #1f2937; padding-top: var(--s3); font-size: 13px; }
    .main { min-width: 0; display: flex; flex-direction: column; }
    header { display: flex; justify-content: flex-end; align-items: center; gap: var(--s3); padding: var(--s3) var(--s5); border-bottom: 1px solid var(--border); background: var(--surface); min-height: 56px; }
    main { flex: 1; }
    @media (max-width: 760px) {
      :host { grid-template-columns: 1fr; }
      aside { position: static; height: auto; }
    }
  `,
})
export class UiShell {
  readonly brand = input('POS');
  readonly subtitle = input<string>();
}
