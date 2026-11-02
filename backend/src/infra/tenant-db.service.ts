import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from './prisma.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantDb {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs fn in a transaction with app.tenant_id set (transaction-local), so RLS scopes every
   * query to this tenant. The setting dies with the transaction; pooled connections stay clean.
   */
  run<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(tenantId)) return Promise.reject(new Error('TenantDb.run requires a tenant uuid'));
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx);
      },
      { timeout: 15_000 },
    );
  }
}
