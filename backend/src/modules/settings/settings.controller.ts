import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { TenantSettingsSchema, type TenantSettings } from '@pos/shared';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { SettingsService } from './settings.service.js';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Any signed-in staff member: the till needs tax and receipt settings. */
  @Get()
  async get(@Req() req: RequestWithContext) {
    const p = await this.settings.profile(req.tenant!.id);
    return { ...p.settings, currency: p.currency, country: p.country, timezone: p.timezone };
  }

  @RequiresPermission('settings.manage')
  @Put()
  update(@Req() req: RequestWithContext, @Body(new ZodPipe(TenantSettingsSchema)) body: TenantSettings) {
    return this.settings.update(req.tenant!.id, body, auditContext(req));
  }
}
