import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { StockAdjustSchema } from '@pos/shared';
import { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { InventoryService } from './inventory.service.js';

const LevelsQuery = z.object({ storeId: z.uuid() });
const MovementsQuery = z.object({ productId: z.uuid(), storeId: z.uuid().optional() });

@Controller('stock')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequiresPermission('stock.adjust')
  @Get()
  levels(@Req() req: RequestWithContext, @Query(new ZodPipe(LevelsQuery)) q: z.infer<typeof LevelsQuery>) {
    return this.inventory.levels(req.tenant!, q.storeId);
  }

  @RequiresPermission('stock.adjust')
  @Get('movements')
  movements(@Req() req: RequestWithContext, @Query(new ZodPipe(MovementsQuery)) q: z.infer<typeof MovementsQuery>) {
    return this.inventory.movements(req.tenant!, q.productId, q.storeId);
  }

  @RequiresPermission('stock.adjust')
  @Post('adjust')
  adjust(@Req() req: RequestWithContext, @Body(new ZodPipe(StockAdjustSchema)) body: z.infer<typeof StockAdjustSchema>) {
    return this.inventory.adjust(req.tenant!, auditContext(req), body);
  }
}
