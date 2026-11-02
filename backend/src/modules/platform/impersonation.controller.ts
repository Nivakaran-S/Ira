import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ImpersonateSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { ImpersonationService } from './impersonation.service.js';

@Realm('platform')
@Controller('platform')
export class ImpersonationController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @Post('tenants/:id/impersonate')
  start(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(ImpersonateSchema)) body: z.infer<typeof ImpersonateSchema>,
  ) {
    return this.impersonation.start(id, body, platformAuditContext(req));
  }

  @Post('impersonations/:sessionId/end')
  @HttpCode(204)
  async end(@Req() req: RequestWithContext, @Param('sessionId', new ParseUUIDPipe()) sessionId: string) {
    await this.impersonation.end(sessionId, platformAuditContext(req));
  }
}
