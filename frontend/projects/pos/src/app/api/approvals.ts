import { Injectable, signal } from '@angular/core';
import { toApiError } from 'ui';
import type { CallHeaders } from './pos-api';

export const ACTION_LABELS: Record<string, string> = {
  'discount.apply': 'Apply a discount',
  'price.override': 'Change a price',
  'sale.void': 'Void a sale',
  'sale.refund': 'Refund',
  'drawer.open': 'Open the cash drawer',
  'shift.close': 'Close the shift',
};

export interface ApprovalRequest {
  action: string;
  resolve(token: string): void;
  reject(): void;
}

export class ApprovalCancelled extends Error {
  constructor() {
    super('Approval cancelled');
  }
}

/**
 * Runs a till call; when the API answers STEP_UP_REQUIRED, asks a manager for their PIN (the
 * approval dialog listens to `pending`) and retries with every approval collected so far.
 */
@Injectable({ providedIn: 'root' })
export class Approvals {
  readonly pending = signal<ApprovalRequest | null>(null);

  ask(action: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pending.set({
        action,
        resolve: (t) => {
          this.pending.set(null);
          resolve(t);
        },
        reject: () => {
          this.pending.set(null);
          reject(new ApprovalCancelled());
        },
      });
    });
  }

  async run<T>(call: (headers: CallHeaders) => Promise<T>): Promise<T> {
    const tokens: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await call(tokens.length ? { 'x-step-up-token': tokens.join(',') } : {});
      } catch (e) {
        const err = toApiError(e);
        const action = (err.details as { action?: string } | undefined)?.action;
        if (err.code !== 'STEP_UP_REQUIRED' || !action) throw err;
        tokens.push(await this.ask(action));
      }
    }
    throw new Error('Too many approvals requested');
  }
}
