import { ChangeDetectionStrategy, Component, inject, Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private next = 1;
  readonly items = signal<Toast[]>([]);

  success(text: string) {
    this.push('success', text);
  }
  error(text: string) {
    this.push('error', text, 8000);
  }
  info(text: string) {
    this.push('info', text);
  }

  dismiss(id: number) {
    this.items.update((list) => list.filter((t) => t.id !== id));
  }

  private push(kind: Toast['kind'], text: string, ms = 4000) {
    const id = this.next++;
    this.items.update((list) => [...list, { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }
}

/** Place once in each app's root template. */
@Component({
  selector: 'ui-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="host" aria-live="polite">
      @for (t of toasts.items(); track t.id) {
        <div class="toast" [class]="t.kind" role="status">
          <span>{{ t.text }}</span>
          <button type="button" aria-label="Dismiss" (click)="toasts.dismiss(t.id)">×</button>
        </div>
      }
    </div>
  `,
  styles: `
    .host { position: fixed; right: var(--s4); bottom: var(--s4); display: flex; flex-direction: column; gap: var(--s2); z-index: 1000; max-width: min(420px, calc(100vw - 32px)); }
    .toast { display: flex; gap: var(--s3); align-items: flex-start; justify-content: space-between; padding: var(--s3) var(--s4); border-radius: var(--radius); box-shadow: var(--shadow-lg); background: var(--surface); border-left: 4px solid var(--accent); }
    .toast.error { border-left-color: var(--danger); }
    .toast.success { border-left-color: var(--ok); }
    button { border: none; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: var(--text-3); }
  `,
})
export class UiToastHost {
  protected readonly toasts = inject(ToastService);
}
