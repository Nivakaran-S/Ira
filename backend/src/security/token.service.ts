import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import { AppError } from '../common/errors/app-error.js';
import { ENV, type Env } from '../config/env.js';

export type Audience = 'tenant' | 'platform' | 'mfa' | 'step-up';

export interface AccessClaims {
  sub: string;
  tid?: string;
  sid?: string;
  did?: string;
  imp?: string;
}

type StandardClaims = { sub: string; jti: string; exp: number; iat: number; iss: string; aud: string };
type Key = Awaited<ReturnType<typeof importPKCS8>>;

const ISSUER = 'pos';
const fromB64 = (v: string) => Buffer.from(v, 'base64').toString('utf8');

@Injectable()
export class TokenService implements OnModuleInit {
  private privateKey!: Key;
  private publicKey!: Key;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async onModuleInit() {
    this.privateKey = await importPKCS8(fromB64(this.env.JWT_PRIVATE_KEY), 'EdDSA');
    this.publicKey = await importSPKI(fromB64(this.env.JWT_PUBLIC_KEY), 'EdDSA');
  }

  sign(aud: Audience, claims: { sub: string } & Record<string, unknown>, ttlSec: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(ISSUER)
      .setAudience(aud)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSec)
      .setJti(randomUUID())
      .sign(this.privateKey);
  }

  async verify<T = Record<string, unknown>>(token: string, aud: Audience): Promise<T & StandardClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, { issuer: ISSUER, audience: aud, algorithms: ['EdDSA'] });
      if (typeof payload.sub !== 'string') throw new Error('missing sub');
      return payload as unknown as T & StandardClaims;
    } catch {
      throw AppError.unauthenticated('Invalid or expired token');
    }
  }
}
