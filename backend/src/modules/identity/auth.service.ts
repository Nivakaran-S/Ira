import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { LoginSchema, MfaVerifySchema, PinLoginSchema, SetupPasswordSchema } from '@pos/shared';
import type { z } from 'zod';
import { Aead } from '../../common/crypto/aead.js';
import { base32Encode } from '../../common/crypto/base32.js';
import { sha256Hex } from '../../common/crypto/hash.js';
import { otpauthUrl, verifyTotp } from '../../common/crypto/totp.js';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { RateLimiter } from '../../infra/rate-limiter.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { PasswordService } from '../../security/password.service.js';
import { TokenService } from '../../security/token.service.js';
import type { RequestMeta } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { LockoutService } from './lockout.service.js';
import { type IssuedSession, SessionService } from './session.service.js';

export type LoginResult =
  | { status: 'ok'; session: IssuedSession }
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_setup_required'; mfaToken: string; otpauthUrl: string; secret: string };

interface MfaClaims {
  tid: string;
  purpose: 'verify' | 'setup';
  /** Encrypted pending secret, only for purpose=setup. */
  sec?: string;
}

const INVALID_LOGIN = 'Invalid email or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly lockout: LockoutService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly aead: Aead,
  ) {}

  async login(tenant: TenantContext, input: z.infer<typeof LoginSchema>, meta: RequestMeta): Promise<LoginResult> {
    const allowed =
      (await this.limiter.consume(`login:${tenant.id}:${input.email}`, 10, 900)) &&
      (await this.limiter.consume(`login-ip:${meta.ip}`, 50, 900));
    if (!allowed) throw AppError.rateLimited();

    const user = await this.tenantDb.run(tenant.id, (tx) =>
      tx.user.findFirst({ where: { email: input.email, status: 'ACTIVE' }, include: { roles: { include: { role: true } } } }),
    );
    if (user) this.lockout.assertNotLocked(user.lockedUntil);
    const ok = await this.passwords.verify(user?.passwordHash, input.password);
    if (!user || !ok) {
      if (user) await this.lockout.recordFailure(tenant.id, user.id, 'password', meta);
      throw AppError.unauthenticated(INVALID_LOGIN);
    }

    const mfaRequired = user.totpSecretEnc !== null || user.roles.some((r) => r.role.requiresMfa);
    if (!mfaRequired) {
      const session = await this.tenantDb.run(tenant.id, async (tx) => {
        await this.lockout.resetInTx(tx, user.id, 'password');
        const s = await this.sessions.start(tx, { tenantId: tenant.id, userId: user.id });
        await this.audit.record(tx, tenant.id, { ...meta, action: 'auth.login', entityType: 'User', entityId: user.id, actorUserId: user.id });
        return s;
      });
      return { status: 'ok', session };
    }

    await this.tenantDb.run(tenant.id, (tx) => this.lockout.resetInTx(tx, user.id, 'password'));
    if (user.totpSecretEnc) {
      return { status: 'mfa_required', mfaToken: await this.tokens.sign('mfa', { sub: user.id, tid: tenant.id, purpose: 'verify' }, 300) };
    }
    const secret = randomBytes(20);
    const mfaToken = await this.tokens.sign(
      'mfa',
      { sub: user.id, tid: tenant.id, purpose: 'setup', sec: this.aead.encrypt(secret.toString('base64')) },
      600,
    );
    return { status: 'mfa_setup_required', mfaToken, otpauthUrl: otpauthUrl('POS', user.email ?? user.id, secret), secret: base32Encode(secret) };
  }

  async verifyMfa(tenant: TenantContext, input: z.infer<typeof MfaVerifySchema>, meta: RequestMeta): Promise<IssuedSession> {
    const claims = await this.tokens.verify<MfaClaims>(input.mfaToken, 'mfa');
    if (claims.tid !== tenant.id) throw AppError.unauthenticated('Invalid or expired token');
    if (!(await this.limiter.consume(`mfa:${claims.sub}`, 5, 300))) throw AppError.rateLimited();

    return this.tenantDb.run(tenant.id, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: claims.sub, status: 'ACTIVE' } });
      if (!user) throw AppError.unauthenticated('Invalid or expired token');

      let secretB64: string;
      if (claims.purpose === 'setup') {
        if (user.totpSecretEnc || !claims.sec) throw AppError.unauthenticated('MFA already enrolled; sign in again');
        secretB64 = this.aead.decrypt(claims.sec);
      } else {
        if (!user.totpSecretEnc) throw AppError.unauthenticated('MFA not enrolled');
        secretB64 = this.aead.decrypt(user.totpSecretEnc);
      }

      const counter = verifyTotp(Buffer.from(secretB64, 'base64'), input.code, Date.now(), user.totpLastCounter);
      if (counter === null) throw AppError.unauthenticated('Invalid code');

      await tx.user.update({
        where: { id: user.id },
        data: { totpLastCounter: counter, ...(claims.purpose === 'setup' ? { totpSecretEnc: this.aead.encrypt(secretB64) } : {}) },
      });
      const session = await this.sessions.start(tx, { tenantId: tenant.id, userId: user.id });
      await this.audit.record(tx, tenant.id, {
        ...meta,
        action: claims.purpose === 'setup' ? 'auth.mfa_enrolled' : 'auth.login',
        entityType: 'User',
        entityId: user.id,
        actorUserId: user.id,
      });
      return session;
    });
  }

  async setupPassword(tenant: TenantContext, input: z.infer<typeof SetupPasswordSchema>, meta: RequestMeta): Promise<void> {
    if (!(await this.limiter.consume(`setup-ip:${meta.ip}`, 10, 900))) throw AppError.rateLimited();
    const passwordHash = await this.passwords.hash(input.password);
    await this.tenantDb.run(tenant.id, async (tx) => {
      const user = await tx.user.findFirst({
        where: { setupTokenHash: sha256Hex(input.code), setupTokenExpiresAt: { gt: new Date() }, status: 'ACTIVE' },
      });
      if (!user) throw AppError.unauthenticated('Invalid or expired setup code');
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, setupTokenHash: null, setupTokenExpiresAt: null } });
      await this.audit.record(tx, tenant.id, { ...meta, action: 'auth.password_set', entityType: 'User', entityId: user.id, actorUserId: user.id });
    });
  }

  async pinLogin(
    tenant: TenantContext,
    device: { id: string },
    input: z.infer<typeof PinLoginSchema>,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    if (!(await this.limiter.consume(`pin-dev:${device.id}`, 30, 900))) throw AppError.rateLimited();
    const user = await this.tenantDb.run(tenant.id, (tx) => tx.user.findFirst({ where: { id: input.userId, status: 'ACTIVE' } }));
    if (user) this.lockout.assertNotLocked(user.pinLockedUntil);
    const ok = await this.passwords.verify(user?.pinHash, input.pin);
    if (!user || !ok) {
      if (user) await this.lockout.recordFailure(tenant.id, user.id, 'pin', { ...meta, deviceId: device.id });
      throw AppError.unauthenticated('Invalid PIN');
    }
    return this.tenantDb.run(tenant.id, async (tx) => {
      await this.lockout.resetInTx(tx, user.id, 'pin');
      const session = await this.sessions.start(tx, { tenantId: tenant.id, userId: user.id, deviceId: device.id });
      await this.audit.record(tx, tenant.id, {
        ...meta,
        action: 'auth.pin_login',
        entityType: 'User',
        entityId: user.id,
        actorUserId: user.id,
        deviceId: device.id,
      });
      return session;
    });
  }
}
