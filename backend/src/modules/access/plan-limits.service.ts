import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';

export type LimitedResource = 'stores' | 'devices' | 'users';

@Injectable()
export class PlanLimitsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Call inside the tenant transaction that creates the resource. */
  async assertCanAdd(tx: Tx, tenant: Pick<TenantContext, 'planId'>, resource: LimitedResource): Promise<void> {
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id: tenant.planId } });
    let count: number;
    let max: number;
    if (resource === 'stores') {
      count = await tx.store.count();
      max = plan.maxStores;
    } else if (resource === 'devices') {
      count = await tx.device.count({ where: { revokedAt: null } });
      max = plan.maxDevices;
    } else {
      count = await tx.user.count({ where: { status: 'ACTIVE' } });
      max = plan.maxUsers;
    }
    if (count >= max) throw new AppError('PLAN_LIMIT_REACHED', 403, `Plan limit reached for ${resource}`, { resource, max });
  }
}
