import { Injectable } from '@nestjs/common';
import type { CreateEnrollmentSchema, EnrollDeviceSchema } from '@pos/shared';
import type { z } from 'zod';
import { randomCode, sha256Hex } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { RateLimiter } from '../../infra/rate-limiter.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { importDeviceKey } from '../../security/device-signature.js';
import { RevocationStore } from '../../security/revocation.store.js';
import { PlanLimitsService } from '../access/plan-limits.service.js';
import type { auditContext, RequestMeta } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { ACCESS_TTL_SEC, SessionService } from './session.service.js';

const ENROLLMENT_TTL_MS = 10 * 60_000;
type Ctx = ReturnType<typeof auditContext>;

@Injectable()
export class DevicesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly limits: PlanLimitsService,
    private readonly sessions: SessionService,
    private readonly revocations: RevocationStore,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
  ) {}

  createEnrollment(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof CreateEnrollmentSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const register = await tx.register.findUnique({ where: { id: input.registerId } });
      if (!register) throw AppError.notFound('Register not found');
      await this.limits.assertCanAdd(tx, tenant, 'devices');
      const code = randomCode(8);
      const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
      await tx.deviceEnrollment.create({
        data: { tenantId: tenant.id, registerId: register.id, codeHash: sha256Hex(code), createdById: ctx.actorUserId!, expiresAt },
      });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'device.enrollment_created', entityType: 'Register', entityId: register.id });
      return { code, expiresAt, registerId: register.id };
    });
  }

  async enroll(tenant: TenantContext, input: z.infer<typeof EnrollDeviceSchema>, meta: RequestMeta) {
    const allowed =
      (await this.limiter.consume(`enroll-ip:${meta.ip}`, 10, 900)) && (await this.limiter.consume(`enroll-tenant:${tenant.id}`, 30, 900));
    if (!allowed) throw AppError.rateLimited();
    try {
      await importDeviceKey(input.publicKeyJwk);
    } catch {
      throw AppError.validation([{ path: 'publicKeyJwk', message: 'Not a valid P-256 public key' }]);
    }

    return this.tenantDb.run(tenant.id, async (tx) => {
      const now = new Date();
      const enrollment = await tx.deviceEnrollment.findFirst({ where: { codeHash: sha256Hex(input.code), usedAt: null, expiresAt: { gt: now } } });
      if (!enrollment) throw AppError.unauthenticated('Invalid or expired enrollment code');
      const claimed = await tx.deviceEnrollment.updateMany({ where: { id: enrollment.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count !== 1) throw AppError.unauthenticated('Invalid or expired enrollment code');
      await this.limits.assertCanAdd(tx, tenant, 'devices');

      const device = await tx.device.create({
        data: {
          tenantId: tenant.id,
          registerId: enrollment.registerId,
          name: input.name,
          publicKeyJwk: input.publicKeyJwk,
          enrolledById: enrollment.createdById,
        },
      });
      await this.audit.record(tx, tenant.id, {
        ...meta,
        action: 'device.enrolled',
        entityType: 'Device',
        entityId: device.id,
        deviceId: device.id,
        actorUserId: enrollment.createdById,
        after: { name: device.name, registerId: device.registerId },
      });
      return { deviceId: device.id, registerId: device.registerId };
    });
  }

  list(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.device.findMany({
        orderBy: { enrolledAt: 'asc' },
        select: { id: true, name: true, registerId: true, enrolledAt: true, enrolledById: true, revokedAt: true },
      }),
    );
  }

  async revoke(tenant: TenantContext, ctx: Ctx, deviceId: string): Promise<void> {
    const familyIds = await this.tenantDb.run(tenant.id, async (tx) => {
      const device = await tx.device.findUnique({ where: { id: deviceId } });
      if (!device) throw AppError.notFound('Device not found');
      if (device.revokedAt) return [];
      await tx.device.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
      const ids = await this.sessions.revokeWhere(tx, { deviceId });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'device.revoked', entityType: 'Device', entityId: deviceId });
      return ids;
    });
    await Promise.all(familyIds.map((id) => this.revocations.markRevoked(id, ACCESS_TTL_SEC)));
  }
}
