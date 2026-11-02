import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { LoginSchema, MfaVerifySchema, SetupPasswordSchema } from '@pos/shared';
import type { z } from 'zod';
import { Aead } from '../../common/crypto/aead.js';
import { base32Encode } from '../../common/crypto/base32.js';
import { sha256Hex } from '../../common/crypto/hash.js';
import { otpauthUrl, verifyTotp } from '../../common/crypto/totp.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { RateLimiter } from '../../infra/rate-limiter.js';
import { PasswordService } from '../../security/password.service.js';
import { TokenService } from '../../security/token.service.js';
import type { RequestMeta } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import type { IssuedSession } from '../identity/session.service.js';
import { LOCK_MS, MAX_FAILURES } from '../identity/lockout.service.js';
import { PlatformSessionService } from './platform-session.service.js';

type PlatformLoginResult =
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_setup_required'; mfaToken: string; otpauthUrl: string; secret: string };

interface PlatformMfaClaims {
  realm: 'platform';
  purpose: 'verify' | 'setup';
  sec?: string;
}

@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: PlatformSessionService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly aead: Aead,
  ) {}

  /** Super admins always complete TOTP; there is no password-only path. */
  async login(input: z.infer<typeof LoginSchema>, meta: RequestMeta): Promise<PlatformLoginResult> {
    const allowed =
      (await this.limiter.consume(`plogin:${input.email}`, 10, 900)) && (await this.limiter.consume(`plogin-ip:${meta.ip}`, 30, 900));
    if (!allowed) throw AppError.rateLimited();

    const admin = await this.prisma.superAdmin.findUnique({ where: { email: input.email } });
    if (admin?.lockedUntil && admin.lockedUntil > new Date()) throw new AppError('ACCOUNT_LOCKED', 423, 'Account temporarily locked');
    const ok = await this.passwords.verify(admin?.passwordHash, input.password);
    if (!admin || !ok) {
      if (admin) {
        await this.prisma.$transaction(async (tx) => {
          const updated = await tx.superAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: { increment: 1 } } });
          if (updated.failedLoginCount >= MAX_FAILURES) {
            await tx.superAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } });
          }
          await this.audit.recordPlatform(tx, { ...meta, action: 'platform.auth.password_failed', entityType: 'SuperAdmin', entityId: admin.id });
        });
      }
      throw AppError.unauthenticated('Invalid email or password');
    }
    await this.prisma.superAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: 0, lockedUntil: null } });

    if (admin.totpSecretEnc) {
      return { status: 'mfa_required', mfaToken: await this.tokens.sign('mfa', { sub: admin.id, realm: 'platform', purpose: 'verify' }, 300) };
    }
    const secret = randomBytes(20);
    const mfaToken = await this.tokens.sign(
      'mfa',
      { sub: admin.id, realm: 'platform', purpose: 'setup', sec: this.aead.encrypt(secret.toString('base64')) },
      600,
    );
    return { status: 'mfa_setup_required', mfaToken, otpauthUrl: otpauthUrl('POS Platform', admin.email, secret), secret: base32Encode(secret) };
  }

  async verifyMfa(input: z.infer<typeof MfaVerifySchema>, meta: RequestMeta): Promise<IssuedSession> {
    const claims = await this.tokens.verify<PlatformMfaClaims>(input.mfaToken, 'mfa');
    if (claims.realm !== 'platform') throw AppError.unauthenticated('Invalid or expired token');
    if (!(await this.limiter.consume(`pmfa:${claims.sub}`, 5, 300))) throw AppError.rateLimited();

    return this.prisma.$transaction(async (tx) => {
      const admin = await tx.superAdmin.findUnique({ where: { id: claims.sub } });
      if (!admin) throw AppError.unauthenticated('Invalid or expired token');
      let secretB64: string;
      if (claims.purpose === 'setup') {
        if (admin.totpSecretEnc || !claims.sec) throw AppError.unauthenticated('MFA already enrolled; sign in again');
        secretB64 = this.aead.decrypt(claims.sec);
      } else {
        if (!admin.totpSecretEnc) throw AppError.unauthenticated('MFA not enrolled');
        secretB64 = this.aead.decrypt(admin.totpSecretEnc);
      }
      const counter = verifyTotp(Buffer.from(secretB64, 'base64'), input.code, Date.now(), admin.totpLastCounter);
      if (counter === null) throw AppError.unauthenticated('Invalid code');
      await tx.superAdmin.update({
        where: { id: admin.id },
        data: { totpLastCounter: counter, ...(claims.purpose === 'setup' ? { totpSecretEnc: this.aead.encrypt(secretB64) } : {}) },
      });
      const session = await this.sessions.start(tx, admin.id);
      await this.audit.recordPlatform(tx, {
        ...meta,
        action: claims.purpose === 'setup' ? 'platform.auth.mfa_enrolled' : 'platform.auth.login',
        entityType: 'SuperAdmin',
        entityId: admin.id,
        actorId: admin.id,
      });
      return session;
    });
  }

  async setupPassword(input: z.infer<typeof SetupPasswordSchema>, meta: RequestMeta): Promise<void> {
    if (!(await this.limiter.consume(`psetup-ip:${meta.ip}`, 10, 900))) throw AppError.rateLimited();
    const passwordHash = await this.passwords.hash(input.password);
    await this.prisma.$transaction(async (tx) => {
      const admin = await tx.superAdmin.findFirst({
        where: { setupTokenHash: sha256Hex(input.code), setupTokenExpiresAt: { gt: new Date() } },
      });
      if (!admin) throw AppError.unauthenticated('Invalid or expired setup code');
      await tx.superAdmin.update({ where: { id: admin.id }, data: { passwordHash, setupTokenHash: null, setupTokenExpiresAt: null } });
      await this.audit.recordPlatform(tx, { ...meta, action: 'platform.auth.password_set', entityType: 'SuperAdmin', entityId: admin.id, actorId: admin.id });
    });
  }
}
