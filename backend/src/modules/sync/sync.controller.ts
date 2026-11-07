import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { SyncDownQuerySchema, SyncUpSchema } from '@pos/shared';
import { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Public, RequiresDevice, RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { SyncService } from './sync.service.js';

/**
 * Device-authenticated, not user-authenticated: offline ops were authorised on the till (PIN and
 * manager approvals checked locally) and carry who did them; the device signature proves where from.
 */
@Public()
@RequiresDevice()
@Controller('pos/sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('down')
  down(@Req() req: RequestWithContext, @Query(new ZodPipe(SyncDownQuerySchema)) q: z.infer<typeof SyncDownQuerySchema>) {
    return this.sync.down(req.tenant!, req.device!, BigInt(q.cursor), q.blockNext);
  }

  @Post('up')
  @HttpCode(200)
  up(@Req() req: RequestWithContext, @Body(new ZodPipe(SyncUpSchema)) body: z.infer<typeof SyncUpSchema>) {
    return this.sync.up(req.tenant!, req.device!, body.ops, auditContext(req), (req.body as { ops: unknown[] }).ops);
  }
}

const ReviewSchema = z.object({ note: z.string().trim().min(3).max(500) });
const ListQuery = z.object({ status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED']).optional() });

@RequiresPermission('sync.review')
@Controller('sync/quarantine')
export class QuarantineController {
  constructor(private readonly sync: SyncService) {}

  @Get()
  list(@Req() req: RequestWithContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.sync.list(req.tenant!, q.status);
  }

  @Get('count')
  async count(@Req() req: RequestWithContext) {
    return { pending: await this.sync.pendingCount(req.tenant!) };
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(ReviewSchema)) body: z.infer<typeof ReviewSchema>) {
    return this.sync.accept(req.tenant!, id, req.principal!.userId, body.note, auditContext(req));
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(ReviewSchema)) body: z.infer<typeof ReviewSchema>) {
    return this.sync.reject(req.tenant!, id, req.principal!.userId, body.note, auditContext(req));
  }
}
