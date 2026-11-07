import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresPermission } from '../access/decorators.js';
import { ReceiptsService } from './receipts.service.js';
import { SalesService } from './sales.service.js';
import { ShiftsService } from './shifts.service.js';

const uuid = new ParseUUIDPipe();

const SalesQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  storeId: z.uuid().optional(),
  registerId: z.uuid().optional(),
  receiptNo: z.string().trim().max(40).optional(),
});
const ShiftsQuery = z.object({ storeId: z.uuid().optional(), registerId: z.uuid().optional() });

@RequiresPermission('report.view')
@Controller('sales')
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly receipts: ReceiptsService,
  ) {}

  @Get()
  list(@Req() req: RequestWithContext, @Query(new ZodPipe(SalesQuery)) q: z.infer<typeof SalesQuery>) {
    return this.sales.list(req.tenant!, {
      ...q,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      receiptNo: q.receiptNo || undefined,
    });
  }

  @Get(':id')
  get(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.sales.get(req.tenant!, id);
  }

  @Get(':id/receipt')
  receipt(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.receipts.forSale(req.tenant!, id, true);
  }
}

@RequiresPermission('report.view')
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get()
  list(@Req() req: RequestWithContext, @Query(new ZodPipe(ShiftsQuery)) q: z.infer<typeof ShiftsQuery>) {
    return this.shifts.list(req.tenant!, q);
  }

  @Get(':id')
  get(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.shifts.get(req.tenant!, id);
  }
}
