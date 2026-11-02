import { Controller, Get, Req } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';

@Controller('me')
export class MeController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly caps: CapabilitiesService,
  ) {}

  @Get()
  async me(@Req() req: RequestWithContext) {
    const p = req.principal!;
    const tenant = req.tenant!;
    const user = await this.tenantDb.run(tenant.id, (tx) =>
      tx.user.findFirst({ where: { id: p.userId, status: 'ACTIVE' }, select: { id: true, name: true, email: true } }),
    );
    if (!user) throw AppError.unauthenticated();
    return {
      user,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      impersonatedBy: p.impersonatorId ?? null,
      deviceId: p.deviceId ?? null,
    };
  }

  @Get('capabilities')
  async capabilities(@Req() req: RequestWithContext) {
    const [modules, permissions] = await Promise.all([
      this.caps.modulesFor(req.tenant!),
      this.caps.permissionsFor(req.tenant!.id, req.principal!.userId),
    ]);
    return { modules, permissions: [...permissions].sort(), impersonatedBy: req.principal!.impersonatorId ?? null };
  }
}
