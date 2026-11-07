import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  BreakdownQuerySchema, PurchaseOrderSchema, ReceivePurchaseSchema, ReceiveTransferSchema, ReportRangeSchema, StorePricesSchema, SupplierSchema, TransferSchema,
} from '@pos/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresModule, RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { AnalyticsService } from '../reporting/analytics.service.js';
import { PurchasingService } from './purchasing.service.js';
import { TransfersService } from './transfers.service.js';

const uuid = new ParseUUIDPipe();
const StoreQuery = z.object({ storeId: z.uuid() });
const MAX_RANGE_MS = 400 * 86_400_000;

function range(from: string, to: string) {
  const f = new Date(from);
  const t = new Date(to);
  if (!(t > f) || t.getTime() - f.getTime() > MAX_RANGE_MS) throw AppError.validation([{ path: 'to', message: 'Range must be positive and at most 400 days' }]);
  return { f, t };
}

@RequiresModule('purchasing')
@RequiresPermission('purchasing.manage')
@Controller()
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Get('suppliers')
  suppliers(@Req() req: RequestWithContext) {
    return this.purchasing.suppliers(req.tenant!);
  }

  @Post('suppliers')
  createSupplier(@Req() req: RequestWithContext, @Body(new ZodPipe(SupplierSchema)) body: z.infer<typeof SupplierSchema>) {
    return this.purchasing.createSupplier(req.tenant!, auditContext(req), body);
  }

  @Get('purchase-orders')
  list(@Req() req: RequestWithContext) {
    return this.purchasing.list(req.tenant!);
  }

  @Get('purchase-orders/:id')
  get(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.purchasing.get(req.tenant!, id);
  }

  @Post('purchase-orders')
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(PurchaseOrderSchema)) body: z.infer<typeof PurchaseOrderSchema>) {
    return this.purchasing.create(req.tenant!, auditContext(req), body);
  }

  @Post('purchase-orders/:id/order')
  @HttpCode(200)
  order(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.purchasing.setStatus(req.tenant!, auditContext(req), id, 'ORDERED');
  }

  @Post('purchase-orders/:id/cancel')
  @HttpCode(200)
  cancel(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.purchasing.setStatus(req.tenant!, auditContext(req), id, 'CANCELLED');
  }

  @Post('purchase-orders/:id/receive')
  @HttpCode(200)
  receive(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(ReceivePurchaseSchema)) body: z.infer<typeof ReceivePurchaseSchema>) {
    return this.purchasing.receive(req.tenant!, auditContext(req), id, body);
  }
}

@RequiresModule('multi-store')
@Controller()
export class MultiStoreController {
  constructor(private readonly transfers: TransfersService) {}

  @RequiresPermission('stock.transfer')
  @Get('transfers')
  list(@Req() req: RequestWithContext) {
    return this.transfers.list(req.tenant!);
  }

  @RequiresPermission('stock.transfer')
  @Post('transfers')
  send(@Req() req: RequestWithContext, @Body(new ZodPipe(TransferSchema)) body: z.infer<typeof TransferSchema>) {
    return this.transfers.send(req.tenant!, auditContext(req), body);
  }

  @RequiresPermission('stock.transfer')
  @Post('transfers/:id/receive')
  @HttpCode(200)
  receive(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(ReceiveTransferSchema)) body: z.infer<typeof ReceiveTransferSchema>) {
    return this.transfers.receive(req.tenant!, auditContext(req), id, body);
  }

  @RequiresPermission('stock.transfer')
  @Post('transfers/:id/cancel')
  @HttpCode(200)
  cancel(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.transfers.cancel(req.tenant!, auditContext(req), id);
  }

  @RequiresPermission('catalog.manage')
  @Get('stores/:id/prices')
  prices(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.transfers.storePrices(req.tenant!, id);
  }

  @RequiresPermission('catalog.manage')
  @Put('stores/:id/prices')
  setPrices(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(StorePricesSchema)) body: z.infer<typeof StorePricesSchema>) {
    return this.transfers.setStorePrices(req.tenant!, auditContext(req), id, body);
  }
}

@RequiresPermission('report.view')
@Controller('reports')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('breakdown')
  breakdown(@Req() req: RequestWithContext, @Query(new ZodPipe(BreakdownQuerySchema)) q: z.infer<typeof BreakdownQuerySchema>) {
    const { f, t } = range(q.from, q.to);
    return this.analytics.breakdown(req.tenant!, q.by, f, t, q.storeId);
  }

  @Get('inventory')
  inventory(@Req() req: RequestWithContext, @Query(new ZodPipe(StoreQuery)) q: z.infer<typeof StoreQuery>) {
    return this.analytics.inventory(req.tenant!, q.storeId);
  }

  @Get('sales.csv')
  async csv(@Req() req: RequestWithContext, @Query(new ZodPipe(ReportRangeSchema)) q: z.infer<typeof ReportRangeSchema>, @Res() res: Response) {
    const { f, t } = range(q.from, q.to);
    const csv = await this.analytics.salesCsv(req.tenant!, f, t, q.storeId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sales-${q.from.slice(0, 10)}-${q.to.slice(0, 10)}.csv"`);
    res.send(csv);
  }
}
