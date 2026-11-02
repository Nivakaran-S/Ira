import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { BusinessTypeSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { BusinessTypesService } from './business-types.service.js';

@Realm('platform')
@Controller('platform/business-types')
export class BusinessTypesController {
  constructor(private readonly businessTypes: BusinessTypesService) {}

  @Get()
  list() {
    return this.businessTypes.list();
  }

  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(BusinessTypeSchema)) body: z.infer<typeof BusinessTypeSchema>) {
    return this.businessTypes.create(body, platformAuditContext(req));
  }

  @Put(':id')
  update(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(BusinessTypeSchema)) body: z.infer<typeof BusinessTypeSchema>,
  ) {
    return this.businessTypes.update(id, body, platformAuditContext(req));
  }
}
