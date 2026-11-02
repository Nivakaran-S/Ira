import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { canonicalJson, toJsonValue } from '../../common/crypto/canonical-json.js';
import { sha256Hex } from '../../common/crypto/hash.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';

export const GENESIS_HASH = '0'.repeat(64);
const PLATFORM_LOCK_KEY = 7_340_001;

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  impersonatorId?: string | null;
  deviceId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface PlatformAuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export type ChainResult = { ok: true; count: number } | { ok: false; brokenAtId: string };

type Hashable = Record<string, unknown> & { id: string; createdAt: Date };

/** The hash covers every stored field except seq, prevHash and hash themselves. */
function hashOf(prevHash: string, row: Hashable): string {
  const { createdAt, ...rest } = row;
  return sha256Hex(prevHash + canonicalJson({ ...rest, createdAt: createdAt.toISOString() }));
}

const jsonOrDbNull = (v: unknown) => (v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

function verifyRows<R extends Hashable & { prevHash: string; hash: string }>(rows: R[], strip: (r: R) => Hashable): ChainResult {
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prevHash !== prev || r.hash !== hashOf(prev, strip(r))) return { ok: false, brokenAtId: r.id };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}

@Injectable()
export class AuditService {
  async record(tx: Tx, tenantId: string, e: AuditEntry): Promise<void> {
    // Serialise writers per tenant so the chain stays linear under concurrency.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text))`;
    const last = await tx.auditEvent.findFirst({ where: { tenantId }, orderBy: { seq: 'desc' }, select: { hash: true } });
    const prevHash = last?.hash ?? GENESIS_HASH;
    const row = {
      id: uuidv7(),
      tenantId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      actorUserId: e.actorUserId ?? null,
      impersonatorId: e.impersonatorId ?? null,
      deviceId: e.deviceId ?? null,
      before: toJsonValue(e.before),
      after: toJsonValue(e.after),
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      correlationId: e.correlationId ?? null,
      createdAt: new Date(),
    };
    await tx.auditEvent.create({
      data: { ...row, before: jsonOrDbNull(row.before), after: jsonOrDbNull(row.after), prevHash, hash: hashOf(prevHash, row) },
    });
  }

  async recordPlatform(tx: Tx, e: PlatformAuditEntry): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_LOCK_KEY}::bigint)`;
    const last = await tx.platformAuditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
    const prevHash = last?.hash ?? GENESIS_HASH;
    const row = {
      id: uuidv7(),
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      actorId: e.actorId ?? null,
      before: toJsonValue(e.before),
      after: toJsonValue(e.after),
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      correlationId: e.correlationId ?? null,
      createdAt: new Date(),
    };
    await tx.platformAuditEvent.create({
      data: { ...row, before: jsonOrDbNull(row.before), after: jsonOrDbNull(row.after), prevHash, hash: hashOf(prevHash, row) },
    });
  }

  async verifyTenantChain(tx: Tx, tenantId: string): Promise<ChainResult> {
    const rows = await tx.auditEvent.findMany({ where: { tenantId }, orderBy: { seq: 'asc' } });
    return verifyRows(rows, ({ seq: _s, prevHash: _p, hash: _h, ...rest }) => rest);
  }

  async verifyPlatformChain(tx: Tx): Promise<ChainResult> {
    const rows = await tx.platformAuditEvent.findMany({ orderBy: { seq: 'asc' } });
    return verifyRows(rows, ({ seq: _s, prevHash: _p, hash: _h, ...rest }) => rest);
  }
}
