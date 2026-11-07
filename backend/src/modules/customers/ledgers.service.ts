import { Injectable } from '@nestjs/common';
import type { LedgerReason } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';

export type LedgerKind = 'loyalty' | 'credit';

export interface LedgerEntry {
  customerId: string;
  delta: number;
  reason: LedgerReason;
  saleId?: string | null;
  refundId?: string | null;
  note?: string | null;
  userId?: string | null;
}

/**
 * Loyalty points and store credit: append-only ledgers, balance = sum of deltas. Writers lock the
 * customer for the rest of the transaction so two tills cannot spend the same balance.
 */
@Injectable()
export class LedgersService {
  async lock(tx: Tx, customerId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cust:${customerId}`}))`;
  }

  async balance(tx: Tx, kind: LedgerKind, customerId: string): Promise<number> {
    const agg = kind === 'loyalty'
      ? await tx.loyaltyLedger.aggregate({ where: { customerId }, _sum: { delta: true } })
      : await tx.storeCreditLedger.aggregate({ where: { customerId }, _sum: { delta: true } });
    return agg._sum.delta ?? 0;
  }

  async add(tx: Tx, tenantId: string, kind: LedgerKind, e: LedgerEntry) {
    if (e.delta === 0) return;
    const data = {
      tenantId, customerId: e.customerId, delta: e.delta, reason: e.reason, saleId: e.saleId ?? null, refundId: e.refundId ?? null,
      note: e.note ?? null, userId: e.userId ?? null,
    };
    if (kind === 'loyalty') await tx.loyaltyLedger.create({ data });
    else await tx.storeCreditLedger.create({ data });
  }

  /** Sum of a sale's entries of one reason, e.g. points already reversed by earlier refunds. */
  async sumFor(tx: Tx, kind: LedgerKind, saleId: string, reason: LedgerReason): Promise<number> {
    const where = { saleId, reason };
    const agg = kind === 'loyalty'
      ? await tx.loyaltyLedger.aggregate({ where, _sum: { delta: true } })
      : await tx.storeCreditLedger.aggregate({ where, _sum: { delta: true } });
    return agg._sum.delta ?? 0;
  }
}
