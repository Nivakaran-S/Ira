import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '../src/config/env.js';
import { InfraModule } from '../src/infra/infra.module.js';
import { PrismaService } from '../src/infra/prisma.service.js';
import { TenantDb } from '../src/infra/tenant-db.service.js';
import { resetDb } from './helpers/db.js';
import { createStore, createTenant } from './helpers/fixtures.js';

describe('TenantDb', () => {
  let tenantDb: TenantDb;
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, InfraModule] }).compile();
    await moduleRef.init();
    tenantDb = moduleRef.get(TenantDb);
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
  });
  afterAll(() => close());
  beforeEach(resetDb);

  it('scopes reads to the given tenant', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    const sa = await createStore(a.id);
    await createStore(b.id);
    const stores = await tenantDb.run(a.id, (tx) => tx.store.findMany());
    expect(stores.map((s) => s.id)).toEqual([sa.id]);
  });

  it('rejects writes for another tenant', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    await expect(
      tenantDb.run(a.id, (tx) => tx.store.create({ data: { tenantId: b.id, name: 'x', code: 'X1' } })),
    ).rejects.toThrow(/row-level security/i);
  });

  it('context does not leak to the next query on the pool', async () => {
    const a = await createTenant({ slug: 'alpha' });
    await createStore(a.id);
    for (let i = 0; i < 5; i++) await tenantDb.run(a.id, (tx) => tx.store.findMany());
    const results = await Promise.all(Array.from({ length: 10 }, () => prisma.store.findMany()));
    for (const r of results) expect(r).toEqual([]);
    const [setting] = await prisma.$queryRaw<{ v: string | null }[]>`SELECT current_setting('app.tenant_id', true) AS v`;
    expect(setting.v ?? '').toBe('');
  });

  it('rolls back all writes when the callback throws', async () => {
    const a = await createTenant({ slug: 'alpha' });
    await expect(
      tenantDb.run(a.id, async (tx) => {
        await tx.store.create({ data: { tenantId: a.id, name: 'x', code: 'X1' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await tenantDb.run(a.id, (tx) => tx.store.count())).toBe(0);
  });

  it('refuses a tenant id that is not a uuid', async () => {
    await expect(tenantDb.run("x' OR 1=1 --", async () => 1)).rejects.toThrow(/tenant uuid/);
  });
});
