import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ChangeBusinessTypeSchema, CreateTenantSchema, UpdateTenantStatusSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { TenantsService } from './tenants.service.js';

@Realm('platform')
@Controller('platform/tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateTenantSchema)) body: z.infer<typeof CreateTenantSchema>) {
    return this.tenants.create(body, platformAuditContext(req));
  }

  @Get()
  list() {
    return this.tenants.list();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.tenants.get(id);
  }

  @Patch(':id/status')
  setStatus(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(UpdateTenantStatusSchema)) body: z.infer<typeof UpdateTenantStatusSchema>,
  ) {
    return this.tenants.setStatus(id, body.status, platformAuditContext(req));
  }

  @Patch(':id/business-type')
  changeBusinessType(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(ChangeBusinessTypeSchema)) body: z.infer<typeof ChangeBusinessTypeSchema>,
  ) {
    return this.tenants.changeBusinessType(id, body.businessTypeId, platformAuditContext(req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.tenants.softDelete(id, platformAuditContext(req));
  }
}
