import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, resource } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PosSession } from '../device/pos-session';

interface Me {
  user: { id: string; name: string };
  tenant: { name: string };
  deviceId: string | null;
}

/** Milestone 1 end state: an enrolled till with a signed-in cashier. Checkout arrives in Milestone 2. */
@Component({
  selector: 'pos-till',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="till">
      <header class="bar">
        <div><strong>{{ me.value()?.tenant?.name }}</strong> <span class="muted">· {{ session.device()?.name }}</span></div>
        <div class="row">
          <span data-testid="cashier">{{ me.value()?.user?.name }}</span>
          <button class="btn" type="button" (click)="lock()">Lock</button>
        </div>
      </header>
      <main class="ready">
        <div class="mark" aria-hidden="true">✓</div>
        <h1 data-testid="till-ready">Till ready</h1>
        <p class="muted">Signed in as {{ me.value()?.user?.name ?? '…' }} on a verified device. Selling arrives with the checkout module.</p>
      </main>
    </div>
  `,
  styles: `
    .till { min-height: 100vh; display: flex; flex-direction: column; }
    .bar { display: flex; justify-content: space-between; align-items: center; padding: var(--s3) var(--s5); background: var(--surface); border-bottom: 1px solid var(--border); }
    .ready { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: var(--s5); }
    .mark { width: 72px; height: 72px; border-radius: 50%; display: grid; place-items: center; background: var(--ok-soft); color: var(--ok); font-size: 36px; margin-bottom: var(--s4); }
  `,
})
export class Till {
  protected readonly session = inject(PosSession);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  protected readonly me = resource({ loader: () => firstValueFrom(this.http.get<Me>('/api/me')) });

  protected async lock() {
    await this.session.lock().catch(() => undefined);
    await this.router.navigateByUrl('/pin');
  }
}
