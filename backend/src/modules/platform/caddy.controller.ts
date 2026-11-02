import { Controller, Get, Query } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { Public, Realm } from '../access/decorators.js';
import { TenantResolverService } from '../access/tenant-resolver.service.js';

/**
 * Caddy's on-demand TLS "ask" hook: a certificate is only issued for hosts we serve.
 * The public edge blocks /api/internal/*; Caddy calls the backend directly.
 */
@Realm('any')
@Public()
@Controller('internal/caddy')
export class CaddyController {
  constructor(private readonly resolver: TenantResolverService) {}

  @Get('ask')
  async ask(@Query('domain') domain?: string) {
    const r = await this.resolver.resolveHost(domain);
    if (r.realm === 'platform' || (r.realm === 'tenant' && r.tenant?.status === 'ACTIVE')) return { ok: true };
    throw AppError.notFound();
  }
}
