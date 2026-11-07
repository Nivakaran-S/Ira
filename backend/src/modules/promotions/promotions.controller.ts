import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { PromotionSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresModule, RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { PromotionsService } from './promotions.service.js';

@RequiresModule('promotions')
@RequiresPermission('promotion.manage')
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  list(@Req() req: RequestWithContext) {
    return this.promotions.list(req.tenant!);
  }

  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(PromotionSchema)) body: z.infer<typeof PromotionSchema>) {
    return this.promotions.create(req.tenant!, auditContext(req), body);
  }

  @Put(':id')
  update(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(PromotionSchema)) body: z.infer<typeof PromotionSchema>) {
    return this.promotions.update(req.tenant!, auditContext(req), id, body);
  }
}
