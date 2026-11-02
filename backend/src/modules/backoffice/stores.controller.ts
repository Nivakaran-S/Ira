import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { CreateStoreSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { OrgService } from './org.service.js';

@Controller('stores')
export class StoresController {
  constructor(private readonly org: OrgService) {}

  @RequiresPermission('store.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateStoreSchema)) body: z.infer<typeof CreateStoreSchema>) {
    return this.org.createStore(req.tenant!, auditContext(req), body);
  }

  @RequiresPermission('store.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.org.listStores(req.tenant!);
  }
}
