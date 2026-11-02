import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { isModuleKey, ModuleOverrideSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { TenantModulesService } from './tenant-modules.service.js';

@Realm('platform')
@Controller('platform/tenants/:id/modules')
export class TenantModulesController {
  constructor(private readonly modules: TenantModulesService) {}

  @Get()
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.modules.get(id);
  }

  @Put()
  set(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(ModuleOverrideSchema)) body: z.infer<typeof ModuleOverrideSchema>,
  ) {
    return this.modules.set(id, body, platformAuditContext(req));
  }

  @Delete(':moduleKey')
  clear(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('moduleKey') moduleKey: string) {
    if (!isModuleKey(moduleKey) || moduleKey === 'core') throw AppError.validation([{ path: 'moduleKey', message: 'Unknown module' }]);
    return this.modules.clear(id, moduleKey, platformAuditContext(req));
  }
}
