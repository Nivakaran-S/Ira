import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { CreateEnrollmentSchema, EnrollDeviceSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Public, RequiresDevice, RequiresPermission } from '../access/decorators.js';
import { auditContext, requestMeta } from '../audit/audit-context.js';
import { DevicesService } from './devices.service.js';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @RequiresPermission('device.enroll')
  @Post('enrollments')
  createEnrollment(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateEnrollmentSchema)) body: z.infer<typeof CreateEnrollmentSchema>) {
    return this.devices.createEnrollment(req.tenant!, auditContext(req), body);
  }

  @Public()
  @Post('enroll')
  enroll(@Req() req: RequestWithContext, @Body(new ZodPipe(EnrollDeviceSchema)) body: z.infer<typeof EnrollDeviceSchema>) {
    return this.devices.enroll(req.tenant!, body, requestMeta(req));
  }

  @RequiresPermission('device.enroll')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.devices.list(req.tenant!);
  }

  @RequiresPermission('device.revoke')
  @Post(':id/revoke')
  @HttpCode(204)
  async revoke(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.devices.revoke(req.tenant!, auditContext(req), id);
  }

  @Public()
  @RequiresDevice()
  @Get('whoami')
  whoami(@Req() req: RequestWithContext) {
    return req.device;
  }
}
