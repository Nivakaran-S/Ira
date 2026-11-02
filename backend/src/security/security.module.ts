import { Global, Module } from '@nestjs/common';
import { Aead } from '../common/crypto/aead.js';
import { ENV, type Env } from '../config/env.js';
import { NonceStore } from './nonce-store.js';
import { PasswordService } from './password.service.js';
import { RevocationStore } from './revocation.store.js';
import { TokenService } from './token.service.js';

@Global()
@Module({
  providers: [
    PasswordService,
    TokenService,
    RevocationStore,
    NonceStore,
    { provide: Aead, inject: [ENV], useFactory: (env: Env) => new Aead(Buffer.from(env.PII_KEY, 'base64')) },
  ],
  exports: [PasswordService, TokenService, RevocationStore, NonceStore, Aead],
})
export class SecurityModule {}
