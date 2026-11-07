import { ChangeDetectionStrategy, Component, computed, input, ViewEncapsulation } from '@angular/core';
import type { ReceiptDoc } from '@pos/shared';
import { RECEIPT_CSS, receiptHtml } from '../hardware/bridge';

/** On-screen receipt, rendered exactly like the browser-print fallback. */
@Component({
  selector: 'pos-receipt-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `<div class="receipt-paper" [innerHTML]="html()"></div>`,
  styles: `
    .receipt-paper { background: #fff; border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s3); max-height: 50vh; overflow: auto; display: flex; justify-content: center; }
    ${RECEIPT_CSS}
  `,
})
export class ReceiptView {
  readonly receipt = input.required<ReceiptDoc>();
  protected readonly html = computed(() => receiptHtml(this.receipt()));
}
