import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { CreateRoleSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { RolesService } from './roles.service.js';

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequiresPermission('role.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateRoleSchema)) body: z.infer<typeof CreateRoleSchema>) {
    return this.roles.create(req.tenant!, req.principal!, auditContext(req), body);
  }

  @RequiresPermission('role.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.roles.list(req.tenant!);
  }
}
