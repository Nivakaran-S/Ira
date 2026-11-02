import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { CreateUserSchema, SetPinSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Public, RequiresDevice, RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequiresPermission('user.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateUserSchema)) body: z.infer<typeof CreateUserSchema>) {
    return this.users.create(req.tenant!, req.principal!, auditContext(req), body);
  }

  @RequiresPermission('user.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.users.list(req.tenant!);
  }

  /** Names for the till's PIN screen. Enrolled devices only; no user session needed. */
  @Public()
  @RequiresDevice()
  @Get('pin-pad')
  pinPad(@Req() req: RequestWithContext) {
    return this.users.pinPad(req.tenant!);
  }

  @RequiresPermission('user.manage')
  @Put(':id/pin')
  @HttpCode(204)
  async setPin(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(SetPinSchema)) body: z.infer<typeof SetPinSchema>,
  ) {
    await this.users.setPin(req.tenant!, req.principal!, auditContext(req), id, body.pin);
  }
}
