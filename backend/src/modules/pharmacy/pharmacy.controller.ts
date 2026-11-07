import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { PrescriptionSchema, ReceiveBatchSchema } from '@pos/shared';
import { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresDevice, RequiresModule, RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { SettingsService } from '../settings/settings.service.js';
import { BatchesService } from './batches.service.js';
import { PrescriptionsService } from './prescriptions.service.js';

const StoreQuery = z.object({ storeId: z.uuid() });
const CustomerQuery = z.object({ customerId: z.uuid() });

@RequiresModule('batch-expiry')
@Controller('batches')
export class BatchesController {
  constructor(
    private readonly batches: BatchesService,
    private readonly settings: SettingsService,
  ) {}

  @RequiresPermission('stock.adjust')
  @Post('receive')
  receive(@Req() req: RequestWithContext, @Body(new ZodPipe(ReceiveBatchSchema)) body: z.infer<typeof ReceiveBatchSchema>) {
    return this.batches.receive(req.tenant!, auditContext(req), body);
  }

  @RequiresPermission('stock.adjust')
  @Get()
  async list(@Req() req: RequestWithContext, @Query(new ZodPipe(StoreQuery)) q: z.infer<typeof StoreQuery>) {
    const s = await this.settings.get(req.tenant!.id);
    return this.batches.list(req.tenant!, q.storeId, s.pharmacy.expiryWarnDays);
  }

  /** Recall: who bought from this lot. */
  @RequiresPermission('report.view')
  @Get(':id/sales')
  sales(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.batches.salesOf(req.tenant!, id);
  }
}

@RequiresModule('prescriptions')
@Controller('prescriptions')
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @RequiresPermission('prescription.dispense')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(PrescriptionSchema)) body: z.infer<typeof PrescriptionSchema>) {
    return this.prescriptions.create(req.tenant!, auditContext(req), req.principal!.userId, body);
  }

  @RequiresPermission('prescription.dispense')
  @Get()
  list(@Req() req: RequestWithContext, @Query(new ZodPipe(CustomerQuery)) q: z.infer<typeof CustomerQuery>) {
    return this.prescriptions.forCustomer(req.tenant!, q.customerId);
  }
}

/** At the pharmacy counter: list a customer's prescriptions; recording one needs a pharmacist. */
@RequiresModule('prescriptions')
@RequiresDevice()
@Controller('pos/prescriptions')
export class PosPrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @RequiresPermission('sale.create')
  @Get()
  list(@Req() req: RequestWithContext, @Query(new ZodPipe(CustomerQuery)) q: z.infer<typeof CustomerQuery>) {
    return this.prescriptions.forCustomer(req.tenant!, q.customerId);
  }

  @RequiresPermission('prescription.dispense')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(PrescriptionSchema)) body: z.infer<typeof PrescriptionSchema>) {
    return this.prescriptions.create(req.tenant!, auditContext(req), req.principal!.userId, body);
  }
}
