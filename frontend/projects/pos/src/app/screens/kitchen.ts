import { ChangeDetectionStrategy, Component, inject, type OnDestroy, type OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { humanMessage, toApiError, ToastService } from 'ui';
import { type KitchenTicket, PosApi } from '../api/pos-api';
import { PosSession } from '../device/pos-session';
import { TillState } from '../till-state';

const NEXT: Record<string, 'PREPARING' | 'READY' | 'SERVED'> = { SENT: 'PREPARING', PREPARING: 'READY', READY: 'SERVED' };

/** Kitchen display: tickets oldest first, tap an item to move it on (sent, preparing, ready, served). */
@Component({
  selector: 'pos-kitchen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="kds">
      <header class="row-between bar">
        <strong>Kitchen</strong>
        <span class="muted small">{{ tickets().length }} open · updated {{ updated() }}</span>
        <button type="button" class="btn" (click)="lock()">Lock</button>
      </header>
      @if (error()) { <div class="banner">{{ error() }}</div> }
      <div class="board">
        @for (t of tickets(); track t.orderId) {
          <section class="ticket" [class.late]="minutes(t.firstSentAt) >= 15" [attr.data-ticket]="t.table ?? t.name">
            <header class="row-between">
              <strong>{{ t.table ?? t.name }}</strong>
              <span class="small">{{ minutes(t.firstSentAt) }} min</span>
            </header>
            @for (l of t.lines; track l.id) {
              <button type="button" class="item" [attr.data-status]="l.status" [attr.data-item]="l.name" (click)="bump(l.id, l.status)">
                <span><strong>{{ state.qty(l.qtyMilli) }}×</strong> {{ l.name }}</span>
                @if (l.modifiers.length) { <span class="small">{{ modText(l.modifiers) }}</span> }
                @if (l.note) { <span class="small note">{{ l.note }}</span> }
                <span class="small state">{{ l.status }}</span>
              </button>
            }
          </section>
        } @empty {
          <p class="muted pad">No tickets. New orders appear here when they are sent.</p>
        }
      </div>
    </div>
  `,
  styles: `
    .kds { min-height: 100vh; background: #1f2937; color: #f9fafb; }
    .bar { padding: var(--s3) var(--s4); background: #111827; }
    .board { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--s3); padding: var(--s4); align-items: start; }
    .ticket { background: #f9fafb; color: var(--text); border-radius: var(--radius-lg); padding: var(--s3); display: flex; flex-direction: column; gap: var(--s2); border-top: 6px solid var(--accent); }
    .ticket.late { border-top-color: var(--danger); }
    .item { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: var(--s2) var(--s3); border-radius: var(--radius); border: 1px solid var(--border); background: #fff; font: inherit; text-align: left; cursor: pointer; }
    .item[data-status='PREPARING'] { background: var(--warn-soft); }
    .item[data-status='READY'] { background: var(--ok-soft); text-decoration: line-through; }
    .note { color: var(--danger); font-weight: 600; }
    .state { color: var(--text-3); }
    .banner { background: var(--danger-soft); color: var(--danger); padding: var(--s2) var(--s4); }
    .pad { padding: var(--s5); color: #d1d5db; }
  `,
})
export class KitchenScreen implements OnInit, OnDestroy {
  protected readonly state = inject(TillState);
  private readonly api = inject(PosApi);
  private readonly session = inject(PosSession);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  protected readonly tickets = signal<KitchenTicket[]>([]);
  protected readonly updated = signal('');
  protected readonly error = signal<string | null>(null);
  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit() {
    void this.load();
    this.timer = setInterval(() => void this.load(), 4_000);
  }
  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async load() {
    try {
      this.tickets.set(await this.api.kitchen());
      this.updated.set(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      this.error.set(null);
    } catch (e) {
      this.error.set(humanMessage(toApiError(e)));
    }
  }

  protected minutes(at: string | null) {
    return at ? Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 60_000)) : 0;
  }
  protected modText(mods: { name: string }[]) {
    return mods.map((m) => m.name).join(', ');
  }

  protected async bump(lineId: string, status: string) {
    const next = NEXT[status];
    if (!next) return;
    try {
      await this.api.bump(lineId, next);
      await this.load();
    } catch (e) {
      this.toasts.error(humanMessage(toApiError(e)));
    }
  }

  protected async lock() {
    await this.session.lock().catch(() => undefined);
    await this.router.navigateByUrl('/pin');
  }
}
