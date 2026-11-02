import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import { ENV, type Env } from '../../../config/env.js';
import type { AccessCheck } from '../access.guard.js';
import { routeRealm } from '../decorators.js';

const normaliseIp = (ip: string | undefined) => (ip ?? '').replace(/^::ffff:/, '');

/** Routes exist only on their own host. Mismatches look like 404, not 403, to avoid probing. */
@Injectable()
export class RealmCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  check(ctx: ExecutionContext, req: RequestWithContext) {
    const realm = routeRealm(this.reflector, ctx);
    if (realm === 'any') return;
    if (realm !== req.hostRealm) throw AppError.notFound();
    const allow = this.env.PLATFORM_IP_ALLOWLIST;
    if (realm === 'platform' && allow.length && !allow.includes(normaliseIp(req.ip))) throw AppError.notFound();
  }
}
