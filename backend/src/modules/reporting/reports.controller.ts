import { Controller, Get, Query, Req } from '@nestjs/common';
import { ReportRangeSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresPermission } from '../access/decorators.js';
import { ReportsService } from './reports.service.js';

const MAX_RANGE_MS = 400 * 24 * 3_600_000;

@RequiresPermission('report.view')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('summary')
  summary(@Req() req: RequestWithContext, @Query(new ZodPipe(ReportRangeSchema)) q: z.infer<typeof ReportRangeSchema>) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (!(to > from) || to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw AppError.validation([{ path: 'to', message: 'Range must be positive and at most 400 days' }]);
    }
    return this.reports.summary(req.tenant!, from, to, q.storeId);
  }
}
