import { ChangeDetectionStrategy, Component, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { uuidv7 } from '@pos/shared';
import { apiResource, humanMessage, toApiError, ToastService } from 'ui';
import { PosApi } from '../api/pos-api';
import { TillState } from '../till-state';

/** Tables and open tabs in this store. Tap a free table to open an order, a busy one to continue it. */
@Component({
  selector: 'pos-floor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Tables</h1>
        <form class="row" (submit)="$event.preventDefault(); openTab()">
          <input aria-label="Tab name" placeholder="Counter tab name" data-testid="tab-name" [value]="tabName()" (input)="tabName.set(val($event))" />
          <button type="submit" class="btn" [disabled]="!tabName().trim()">Open tab</button>
        </form>
      </div>
      @if (state.offline()) {
        <p class="error-text">Tables need a connection to the server.</p>
      }
      <div class="tables">
        @for (t of floor.value()?.tables ?? []; track t.id) {
          <button type="button" class="table" [class.busy]="!!t.order" [attr.data-table]="t.name" (click)="openTable(t.id, t.order?.id ?? null)">
            <strong>{{ t.name }}</strong>
            <span class="small muted">{{ t.area ?? '' }} · {{ t.seats }} seats</span>
            @if (t.order; as o) {
              <span>{{ state.money(o.total) }}</span>
              <span class="small">
                @if (o.unsent) { <span class="tag warn">{{ o.unsent }} not sent</span> }
                @if (o.ready) { <span class="tag ok">{{ o.ready }} ready</span> }
              </span>
            } @else {
              <span class="small muted">Free</span>
            }
          </button>
        }
        @for (o of floor.value()?.tabs ?? []; track o.id) {
          <button type="button" class="table busy" [attr.data-tab]="o.name" (click)="go(o.id)">
            <strong>{{ o.name }}</strong>
            <span class="small muted">Tab</span>
            <span>{{ state.money(o.total) }}</span>
          </button>
        }
      </div>
      @if (floor.errorMessage()) {
        <p class="error-text">{{ floor.errorMessage() }}</p>
      }
    </div>
  `,
  styles: `
    .tables { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--s3); }
    .table { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; padding: var(--s4); min-height: 120px; border-radius: var(--radius-lg); border: 2px solid var(--border); background: var(--surface); font: inherit; text-align: left; cursor: pointer; }
    .table.busy { border-color: var(--accent); background: var(--accent-soft); }
    .tag { padding: 0 6px; border-radius: 6px; margin-right: 4px; }
    .tag.warn { background: var(--warn-soft); color: var(--warn); }
    .tag.ok { background: var(--ok-soft); color: var(--ok); }
  `,
})
export class FloorScreen implements OnInit, OnDestroy {
  protected readonly state = inject(TillState);
  private readonly api = inject(PosApi);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly floor = apiResource({ loader: () => this.api.floor() });
  protected readonly tabName = signal('');
  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit() {
    // Other tills change the floor too: keep it fresh.
    this.timer = setInterval(() => this.floor.reload(), 10_000);
  }
  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  protected val(e: Event) {
    return (e.target as HTMLInputElement).value;
  }

  protected go(orderId: string) {
    void this.router.navigate(['/till/orders', orderId]);
  }

  protected async openTable(tableId: string, orderId: string | null) {
    if (orderId) return this.go(orderId);
    try {
      const o = await this.api.openOrder({ id: uuidv7(), tableId });
      this.go(o.id);
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
      this.floor.reload();
    }
  }

  protected async openTab() {
    try {
      const o = await this.api.openOrder({ id: uuidv7(), name: this.tabName().trim() });
      this.tabName.set('');
      this.go(o.id);
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }
}
