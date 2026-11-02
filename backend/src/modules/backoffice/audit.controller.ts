import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, Req } from '@nestjs/common';
import type { RequestWithContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { RequiresPermission } from '../access/decorators.js';
import { AuditService } from '../audit/audit.service.js';

@Controller('audit')
export class AuditController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  @RequiresPermission('audit.view')
  @Get()
  async list(@Req() req: RequestWithContext, @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number) {
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.tenantDb.run(req.tenant!.id, (tx) => tx.auditEvent.findMany({ orderBy: { seq: 'desc' }, take }));
    return rows.map(({ seq, ...rest }) => ({ ...rest, seq: seq.toString() }));
  }

  @RequiresPermission('audit.view')
  @Get('verify')
  verify(@Req() req: RequestWithContext) {
    return this.tenantDb.run(req.tenant!.id, (tx) => this.audit.verifyTenantChain(tx, req.tenant!.id));
  }
}
