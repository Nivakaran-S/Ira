import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, resource, signal } from '@angular/core';
import { humanMessage, toApiError, UiBadge, UiEmpty } from 'ui';
import { BackofficeApi, type ChainResult } from './backoffice-api';

@Component({
  selector: 'admin-audit',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiBadge, UiEmpty, DatePipe],
  template: `
    <div class="page stack">
      <div class="row-between">
        <h1>Audit log</h1>
        <div class="row">
          @if (chain(); as c) {
            @if (c.ok) {
              <ui-badge tone="ok" data-testid="chain-ok">Chain intact · {{ c.count }} events</ui-badge>
            } @else {
              <ui-badge tone="danger">Chain broken at {{ c.brokenAtId }}</ui-badge>
            }
          }
          <button class="btn" type="button" (click)="verify()">Verify chain</button>
        </div>
      </div>
      <p class="muted small">Append-only and hash-chained. Showing the latest 100 events.</p>
      @if (verifyError()) {
        <div class="error-text">{{ verifyError() }}</div>
      }
      <section class="card flush">
        @if (events.value()?.length) {
          <table class="ui-table">
            <thead><tr><th>#</th><th>When</th><th>Action</th><th>Entity</th><th>Actor</th></tr></thead>
            <tbody>
              @for (e of events.value(); track e.id) {
                <tr>
                  <td class="mono small">{{ e.seq }}</td>
                  <td class="small">{{ e.createdAt | date: 'medium' }}</td>
                  <td class="mono small">{{ e.action }}</td>
                  <td class="small">{{ e.entityType }}</td>
                  <td class="small">
                    @if (e.impersonatorId) { <ui-badge tone="warn">Impersonated</ui-badge> }
                    @if (e.deviceId) { <ui-badge>Till</ui-badge> }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <ui-empty [title]="events.isLoading() ? 'Loading…' : 'No events'" />
        }
      </section>
    </div>
  `,
})
export class Audit {
  private readonly api = inject(BackofficeApi);
  protected readonly events = resource({ loader: () => this.api.audit(100) });
  protected readonly chain = signal<ChainResult | null>(null);
  protected readonly verifyError = signal<string | null>(null);

  protected async verify() {
    this.verifyError.set(null);
    try {
      this.chain.set(await this.api.verifyAudit());
    } catch (e) {
      this.verifyError.set(humanMessage(toApiError(e)));
    }
  }
}
