import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../src/generated/prisma/client.js';
import { appDb, ownerDb, resetDb } from './helpers/db.js';
import { createStore, createTenant } from './helpers/fixtures.js';

/** Platform tables that carry tenantId on purpose and are read before tenant context exists. */
const PLATFORM_TABLES_WITH_TENANT_ID = ['Domain', 'TenantModule'];

const app = appDb();
afterAll(() => app.$disconnect());

function asTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

describe('row-level security', () => {
  beforeEach(resetDb);

  it('every table with a tenantId column has RLS enabled and a tenant_isolation policy', async () => {
    const rows = await ownerDb().$queryRaw<{ table: string; rls: boolean; policy: string | null }[]>`
      SELECT c.relname AS "table", c.relrowsecurity AS rls, p.polname AS policy
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
      LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
      WHERE c.relkind = 'r'`;
    const scoped = rows.filter((r) => !PLATFORM_TABLES_WITH_TENANT_ID.includes(r.table));
    expect(scoped.length).toBeGreaterThanOrEqual(10);
    for (const r of scoped) expect(r).toEqual({ table: r.table, rls: true, policy: 'tenant_isolation' });
  });

  it('the app role cannot bypass RLS and owns no tables', async () => {
    const [role] = await ownerDb().$queryRaw<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'pos_app'`;
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await ownerDb().$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'pos_app'`;
    expect(Number(owned[0].n)).toBe(0);
  });

  it('without tenant context the app role sees no tenant rows', async () => {
    const a = await createTenant({ slug: 'alpha' });
    await createStore(a.id);
    expect(await app.store.findMany()).toEqual([]);
  });

  it('with tenant context only that tenant’s rows are visible', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    const sa = await createStore(a.id);
    await createStore(b.id);
    const seen = await asTenant(a.id, (tx) => tx.store.findMany());
    expect(seen.map((s) => s.id)).toEqual([sa.id]);
  });

  it('WITH CHECK blocks writing a row for another tenant', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    await expect(
      asTenant(a.id, (tx) => tx.store.create({ data: { tenantId: b.id, name: 'Sneaky', code: 'X1' } })),
    ).rejects.toThrow(/row-level security/i);
  });

  it('composite FK blocks a cross-tenant reference', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    const storeB = await createStore(b.id);
    await expect(
      asTenant(a.id, (tx) => tx.register.create({ data: { tenantId: a.id, storeId: storeB.id, name: 'Till', code: 'T1' } })),
    ).rejects.toThrow(/foreign key/i);
  });

  it('cannot read another tenant’s row by id even when the id is known', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    const sb = await createStore(b.id);
    expect(await asTenant(a.id, (tx) => tx.store.findUnique({ where: { id: sb.id } }))).toBeNull();
    // also unaffected by an update attempt
    const updated = await asTenant(a.id, (tx) => tx.store.updateMany({ where: { id: sb.id }, data: { name: 'pwned' } }));
    expect(updated.count).toBe(0);
  });

  it('the app role cannot update or delete audit events', async () => {
    const a = await createTenant({ slug: 'alpha' });
    await expect(asTenant(a.id, (tx) => tx.auditEvent.deleteMany({}))).rejects.toThrow(/permission denied/i);
    await expect(
      asTenant(a.id, (tx) => tx.auditEvent.updateMany({ data: { action: 'x' } })),
    ).rejects.toThrow(/permission denied/i);
  });
});
