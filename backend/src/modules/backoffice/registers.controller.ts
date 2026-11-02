import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { CreateRegisterSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { OrgService } from './org.service.js';

@Controller('registers')
export class RegistersController {
  constructor(private readonly org: OrgService) {}

  @RequiresPermission('register.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateRegisterSchema)) body: z.infer<typeof CreateRegisterSchema>) {
    return this.org.createRegister(req.tenant!, auditContext(req), body);
  }

  @RequiresPermission('register.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.org.listRegisters(req.tenant!);
  }
}
