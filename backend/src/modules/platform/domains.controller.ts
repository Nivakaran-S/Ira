import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AddDomainSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { DomainsService } from './domains.service.js';

@Realm('platform')
@Controller('platform/tenants/:id/domains')
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Post()
  add(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(AddDomainSchema)) body: z.infer<typeof AddDomainSchema>,
  ) {
    return this.domains.add(id, body.hostname, platformAuditContext(req));
  }

  @Get()
  list(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.domains.list(id);
  }

  @Post(':domainId/verify')
  @HttpCode(200)
  verify(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('domainId', new ParseUUIDPipe()) domainId: string) {
    return this.domains.verify(id, domainId, platformAuditContext(req));
  }

  @Delete(':domainId')
  @HttpCode(204)
  async remove(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('domainId', new ParseUUIDPipe()) domainId: string) {
    await this.domains.remove(id, domainId, platformAuditContext(req));
  }
}
