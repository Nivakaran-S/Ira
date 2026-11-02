import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

let owner: PrismaClient | undefined;

/** Connects as pos_owner: bypasses RLS. Only for fixtures and assertions, never app code. */
export function ownerDb(): PrismaClient {
  owner ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_OWNER_URL! }) });
  return owner;
}

/** A fresh client as pos_app (subject to RLS). Caller disconnects. */
export function appDb(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
}

export async function resetDb(): Promise<void> {
  const db = ownerDb();
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length) {
    await db.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
}
