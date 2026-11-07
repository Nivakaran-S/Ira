import { ChangeDetectionStrategy, Component, inject, type OnInit } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { DatePipe } from '@angular/common';
import { ApiError, humanMessage, toApiError } from 'ui';
import { PosSession } from '../device/pos-session';
import { HardwareBridge } from '../hardware/bridge';
import { TillState } from '../till-state';
import { ApprovalDialog } from './approval-dialog';

/** The till frame: who is on, which register, the tabs, and the manager-approval dialog. */
@Component({
  selector: 'pos-till',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterOutlet, RouterLink, RouterLinkActive, ApprovalDialog],
  template: `
    <div class="till">
      <header class="bar">
        <div class="who">
          <strong>{{ state.tenantName() }}</strong>
          <span class="muted">· {{ session.device()?.name }}</span>
          @if (state.shiftOpen()) {
            <span class="pill ok" data-testid="shift-open">Shift open</span>
          } @else if (state.loaded()) {
            <span class="pill warn">No shift</span>
          }
          @if (state.sync.online()) {
            <span class="pill ok" data-testid="online">Online</span>
          } @else {
            <span class="pill warn" data-testid="offline">Offline</span>
          }
          @if (state.sync.outbox()) {
            <span class="pill warn" data-testid="outbox" title="Offline entries waiting to sync">{{ state.sync.outbox() }} to sync</span>
          }
          @if (state.sync.lastContactAt(); as at) {
            <span class="small muted" title="Last successful sync">Synced {{ at | date: 'shortTime' }}</span>
          }
          @if (bridge.ready()) {
            <span class="pill" title="Receipt printer connected">Printer</span>
          }
        </div>
        <nav class="tabs">
          <a routerLink="/till" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Sell</a>
          <a routerLink="/till/sales" routerLinkActive="active" data-testid="tab-sales">Sales</a>
          <a routerLink="/till/refund" routerLinkActive="active" data-testid="tab-refund">Refund</a>
          <a routerLink="/till/shift" routerLinkActive="active" data-testid="tab-shift">Shift</a>
        </nav>
        <div class="row">
          <span data-testid="cashier">{{ state.cashier()?.name }}</span>
          <button class="btn" type="button" (click)="lock()">Lock</button>
        </div>
      </header>
      @if (state.offline() && !state.sync.offlineAllowed().ok) {
        <div class="banner" role="alert" data-testid="offline-stop">{{ offlineReason() }}</div>
      }
      @if (state.error()) {
        <div class="banner" role="alert">
          {{ errorText() }} <button class="btn small" type="button" (click)="state.load()">Retry</button>
        </div>
      }
      <main><router-outlet /></main>
    </div>
    <pos-approval-dialog />
  `,
  styles: `
    .till { height: 100vh; display: flex; flex-direction: column; }
    .bar { display: flex; justify-content: space-between; align-items: center; gap: var(--s3); padding: var(--s2) var(--s4); background: var(--surface); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
    .who { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
    .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--surface-2); color: var(--text-2); }
    .pill.ok { background: var(--ok-soft); color: var(--ok); }
    .pill.warn { background: var(--warn-soft); color: var(--warn); }
    .tabs { display: flex; gap: var(--s1); }
    .tabs a { padding: var(--s2) var(--s4); border-radius: var(--radius); text-decoration: none; color: var(--text-2); font-weight: 600; }
    .tabs a.active { background: var(--accent-soft); color: var(--accent); }
    .banner { background: var(--danger-soft); color: var(--danger); padding: var(--s2) var(--s4); }
    main { flex: 1; min-height: 0; overflow: auto; }
  `,
})
export class Till implements OnInit {
  protected readonly session = inject(PosSession);
  protected readonly state = inject(TillState);
  protected readonly bridge = inject(HardwareBridge);
  private readonly router = inject(Router);

  ngOnInit() {
    void this.state.load();
    void this.bridge.check();
  }

  protected errorText() {
    const e = this.state.error();
    return e instanceof Error && !(e instanceof ApiError) ? e.message : humanMessage(toApiError(e));
  }

  protected offlineReason() {
    const a = this.state.sync.offlineAllowed();
    return a.ok ? '' : a.reason;
  }

  protected async lock() {
    await this.session.lock().catch(() => undefined);
    this.state.reset();
    await this.router.navigateByUrl('/pin');
  }
}
