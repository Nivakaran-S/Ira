import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '../src/config/env.js';
import { InfraModule } from '../src/infra/infra.module.js';
import { PrismaService } from '../src/infra/prisma.service.js';
import { TenantDb } from '../src/infra/tenant-db.service.js';
import { AuditModule } from '../src/modules/audit/audit.module.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { createTenant } from './helpers/fixtures.js';

describe('AuditService', () => {
  let audit: AuditService;
  let tenantDb: TenantDb;
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [ConfigModule, InfraModule, AuditModule] }).compile();
    await m.init();
    audit = m.get(AuditService);
    tenantDb = m.get(TenantDb);
    prisma = m.get(PrismaService);
    close = () => m.close();
  });
  afterAll(() => close());
  beforeEach(resetDb);

  const write = (tenantId: string, i: number) =>
    tenantDb.run(tenantId, (tx) =>
      audit.record(tx, tenantId, { action: 'test.event', entityType: 'Test', entityId: String(i), after: { i, at: new Date(0) } }),
    );

  it('chains events and verifies', async () => {
    const t = await createTenant({ slug: 'alpha' });
    for (let i = 0; i < 3; i++) await write(t.id, i);
    const rows = await ownerDb().auditEvent.findMany({ orderBy: { seq: 'asc' } });
    expect(rows[0].prevHash).toBe('0'.repeat(64));
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(await tenantDb.run(t.id, (tx) => audit.verifyTenantChain(tx, t.id))).toEqual({ ok: true, count: 3 });
  });

  it('keeps one chain per tenant', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    await write(a.id, 1);
    await write(b.id, 1);
    const rows = await ownerDb().auditEvent.findMany();
    expect(rows.every((r) => r.prevHash === '0'.repeat(64))).toBe(true);
  });

  it('detects a modified event', async () => {
    const t = await createTenant({ slug: 'alpha' });
    for (let i = 0; i < 3; i++) await write(t.id, i);
    const rows = await ownerDb().auditEvent.findMany({ orderBy: { seq: 'asc' } });
    await ownerDb().auditEvent.update({ where: { id: rows[1].id }, data: { after: { i: 999 } } });
    expect(await tenantDb.run(t.id, (tx) => audit.verifyTenantChain(tx, t.id))).toEqual({ ok: false, brokenAtId: rows[1].id });
  });

  it('detects a deleted event', async () => {
    const t = await createTenant({ slug: 'alpha' });
    for (let i = 0; i < 3; i++) await write(t.id, i);
    const rows = await ownerDb().auditEvent.findMany({ orderBy: { seq: 'asc' } });
    await ownerDb().auditEvent.delete({ where: { id: rows[1].id } });
    expect(await tenantDb.run(t.id, (tx) => audit.verifyTenantChain(tx, t.id))).toEqual({ ok: false, brokenAtId: rows[2].id });
  });

  it('concurrent writes keep a linear chain', async () => {
    const t = await createTenant({ slug: 'alpha' });
    await Promise.all(Array.from({ length: 10 }, (_, i) => write(t.id, i)));
    const result = await tenantDb.run(t.id, (tx) => audit.verifyTenantChain(tx, t.id));
    expect(result).toEqual({ ok: true, count: 10 });
  });

  it('chains platform events', async () => {
    for (let i = 0; i < 3; i++) {
      await prisma.$transaction((tx) => audit.recordPlatform(tx, { action: 'p.test', entityType: 'Test', entityId: String(i) }));
    }
    expect(await prisma.$transaction((tx) => audit.verifyPlatformChain(tx))).toEqual({ ok: true, count: 3 });
  });
});
