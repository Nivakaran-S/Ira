import { Injectable } from '@nestjs/common';
import type { CreateUserSchema } from '@pos/shared';
import type { z } from 'zod';
import { randomToken, sha256Hex } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import type { Principal, TenantContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { PasswordService } from '../../security/password.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import { PlanLimitsService } from '../access/plan-limits.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { assertCanGrant } from './grant-rules.js';

const USER_SETUP_TTL_MS = 7 * 24 * 3_600_000;
type Ctx = ReturnType<typeof auditContext>;

const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  status: true,
  pinHash: true,
  roles: { select: { role: { select: { id: true, name: true } } } },
} as const;

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  status: string;
  pinHash: string | null;
  roles: { role: { id: string; name: string } }[];
};

/** The only shape a user leaves the API in: no hashes, no secrets. */
const toPublicUser = (u: UserRow) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  status: u.status,
  roles: u.roles.map((r) => r.role),
  hasPin: u.pinHash !== null,
});

@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly capabilities: CapabilitiesService,
    private readonly limits: PlanLimitsService,
    private readonly audit: AuditService,
  ) {}

  async create(tenant: TenantContext, principal: Principal, ctx: Ctx, input: z.infer<typeof CreateUserSchema>) {
    const actor = await this.capabilities.permissionsFor(tenant.id, principal.userId);
    const pinHash = input.pin ? await this.passwords.hash(input.pin) : null;
    const setupCode = input.email ? randomToken(24) : null;
    return this.tenantDb.run(tenant.id, async (tx) => {
      await this.limits.assertCanAdd(tx, tenant, 'users');
      const roleIds = [...new Set(input.roleIds)];
      const roles = await tx.role.findMany({ where: { id: { in: roleIds } } });
      if (roles.length !== roleIds.length) throw AppError.notFound('Role not found');
      assertCanGrant(actor, roles.flatMap((r) => r.permissions));
      const created = await tx.user.create({
        data: {
          tenantId: tenant.id,
          name: input.name,
          email: input.email ?? null,
          pinHash,
          setupTokenHash: setupCode ? sha256Hex(setupCode) : null,
          setupTokenExpiresAt: setupCode ? new Date(Date.now() + USER_SETUP_TTL_MS) : null,
        },
      });
      await tx.userRole.createMany({ data: roles.map((r) => ({ tenantId: tenant.id, userId: created.id, roleId: r.id })) });
      await this.audit.record(tx, tenant.id, {
        ...ctx,
        action: 'user.created',
        entityType: 'User',
        entityId: created.id,
        after: { name: input.name, email: input.email ?? null, roleIds, hasPin: pinHash !== null },
      });
      const user = await tx.user.findUniqueOrThrow({ where: { id: created.id }, select: publicUserSelect });
      return { user: toPublicUser(user), setupCode };
    });
  }

  async list(tenant: TenantContext) {
    const users = await this.tenantDb.run(tenant.id, (tx) => tx.user.findMany({ orderBy: { name: 'asc' }, select: publicUserSelect }));
    return users.map(toPublicUser);
  }

  async setPin(tenant: TenantContext, principal: Principal, ctx: Ctx, userId: string, pin: string) {
    const actor = await this.capabilities.permissionsFor(tenant.id, principal.userId);
    const pinHash = await this.passwords.hash(pin);
    await this.tenantDb.run(tenant.id, async (tx) => {
      const target = await tx.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
      if (!target) throw AppError.notFound('User not found');
      // Setting someone's PIN lets you sign in as them on a till: same rule as granting their roles.
      assertCanGrant(actor, target.roles.flatMap((r) => r.role.permissions));
      await tx.user.update({ where: { id: userId }, data: { pinHash, pinFailedCount: 0, pinLockedUntil: null } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'user.pin_set', entityType: 'User', entityId: userId });
    });
  }

  pinPad(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.user.findMany({ where: { status: 'ACTIVE', pinHash: { not: null } }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    );
  }
}
