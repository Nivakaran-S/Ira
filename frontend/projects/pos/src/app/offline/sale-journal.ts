import { inject, Injectable } from '@angular/core';
import type { Sale } from '../api/pos-api';
import { LocalDb } from './local-db';

/** How long the till remembers its sales for refunds and voids without a connection. */
export const JOURNAL_DAYS = 7;

/**
 * The sales this till made (online or offline) or looked up, kept locally by receipt number, so a
 * refund or void can find the sale and its line ids when the server cannot be reached.
 */
@Injectable({ providedIn: 'root' })
export class SaleJournal {
  private readonly db = inject(LocalDb);

  put(sale: Sale): Promise<void> {
    return this.db.put('sales', sale.receiptNo, sale);
  }

  get(receiptNo: string): Promise<Sale | undefined> {
    return this.db.get<Sale>('sales', receiptNo);
  }

  async update(receiptNo: string, change: (s: Sale) => Sale): Promise<Sale | undefined> {
    const s = await this.get(receiptNo);
    if (!s) return undefined;
    const next = change(s);
    await this.put(next);
    return next;
  }

  /** Newest first. */
  async recent(limit = 30): Promise<Sale[]> {
    const all = await this.db.all<Sale>('sales');
    return all.map((r) => r.value).sort((a, b) => b.soldAt.localeCompare(a.soldAt)).slice(0, limit);
  }

  async byId(id: string): Promise<Sale | undefined> {
    return (await this.db.all<Sale>('sales')).find((r) => r.value.id === id)?.value;
  }

  /** Forgets sales older than the retention window. */
  async prune(now = Date.now()): Promise<void> {
    const cutoff = new Date(now - JOURNAL_DAYS * 86_400_000).toISOString();
    for (const r of await this.db.all<Sale>('sales')) if (r.value.soldAt < cutoff) await this.db.delete('sales', r.key);
  }
}
