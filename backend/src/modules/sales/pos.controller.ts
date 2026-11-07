import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { PERMISSIONS, type Permission, CashMovementSchema, CloseShiftSchema, CreateRefundSchema, CreateSaleSchema, OpenShiftSchema, VoidSaleSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import { RequiresDevice, RequiresPermission, RequiresStepUp } from '../access/decorators.js';
import { StepUpGate } from '../access/step-up-gate.js';
import { auditContext } from '../audit/audit-context.js';
import { ReceiptsService } from './receipts.service.js';
import { SalesService } from './sales.service.js';
import { ShiftsService } from './shifts.service.js';

const uuid = new ParseUUIDPipe();

/** Till endpoints: always device-signed, always scoped to the device's register. */
@RequiresDevice()
@RequiresPermission('sale.create')
@Controller('pos')
export class PosController {
  constructor(
    private readonly shifts: ShiftsService,
    private readonly sales: SalesService,
    private readonly receipts: ReceiptsService,
    private readonly gate: StepUpGate,
    private readonly capabilities: CapabilitiesService,
    private readonly tenantDb: TenantDb,
  ) {}

  private async holds(req: RequestWithContext, permission: Parameters<StepUpGate['require']>[1]) {
    return (await this.capabilities.permissionsFor(req.tenant!.id, req.principal!.userId)).has(permission);
  }

  /** Staff who could approve `action` on this till: they hold it and have a PIN. */
  @Get('approvers')
  async approvers(@Req() req: RequestWithContext, @Query('action') action?: string) {
    if (!action || !(PERMISSIONS as readonly string[]).includes(action)) throw AppError.validation([{ path: 'action', message: 'Unknown action' }]);
    const users = await this.tenantDb.run(req.tenant!.id, (tx) =>
      tx.user.findMany({ where: { status: 'ACTIVE', pinHash: { not: null } }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    );
    const out: { id: string; name: string }[] = [];
    for (const u of users) if ((await this.capabilities.permissionsFor(req.tenant!.id, u.id)).has(action as Permission)) out.push(u);
    return out;
  }

  @Get('shift')
  async shift(@Req() req: RequestWithContext) {
    return { shift: await this.shifts.current(req.tenant!, req.device!.registerId) };
  }

  @Post('shift/open')
  open(@Req() req: RequestWithContext, @Body(new ZodPipe(OpenShiftSchema)) body: z.infer<typeof OpenShiftSchema>) {
    return this.shifts.open(req.tenant!, req.device!.registerId, req.principal!.userId, body.openingFloat, auditContext(req));
  }

  @Post('shift/cash')
  async cash(@Req() req: RequestWithContext, @Body(new ZodPipe(CashMovementSchema)) body: z.infer<typeof CashMovementSchema>) {
    // Opening the drawer without a sale always needs a manager; pay-ins and pay-outs need drawer.open.
    const approvedBy = await this.gate.unlessPermitted(req, 'drawer.open', await this.holds(req, 'drawer.open'), body.type === 'NO_SALE');
    return this.shifts.cashMovement(req.tenant!, req.device!.registerId, req.principal!.userId, body, approvedBy, auditContext(req));
  }

  @Post('shift/close')
  @HttpCode(200)
  async close(@Req() req: RequestWithContext, @Body(new ZodPipe(CloseShiftSchema)) body: z.infer<typeof CloseShiftSchema>) {
    const approvedBy = await this.gate.unlessPermitted(req, 'shift.close', await this.holds(req, 'shift.close'));
    return this.shifts.close(req.tenant!, req.device!.registerId, req.principal!.userId, body, approvedBy, auditContext(req));
  }

  @Post('sales')
  @HttpCode(200)
  sell(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateSaleSchema)) body: z.infer<typeof CreateSaleSchema>) {
    return this.sales.create(req, body);
  }

  @Get('sales/recent')
  recent(@Req() req: RequestWithContext) {
    return this.sales.recentForRegister(req.tenant!, req.device!.registerId);
  }

  @Get('sales/lookup')
  lookup(@Req() req: RequestWithContext, @Query('receiptNo') receiptNo?: string) {
    const r = receiptNo?.trim().toUpperCase();
    if (!r || r.length > 40) throw AppError.validation([{ path: 'receiptNo', message: 'Receipt number required' }]);
    return this.sales.findByReceipt(req.tenant!, r);
  }

  @Get('sales/:id')
  get(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.sales.get(req.tenant!, id);
  }

  @Get('sales/:id/receipt')
  receipt(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Query('copy') copy?: string) {
    return this.receipts.forSale(req.tenant!, id, copy === 'true');
  }

  @RequiresStepUp('sale.void')
  @Post('sales/:id/void')
  @HttpCode(200)
  void(@Req() req: RequestWithContext, @Param('id', uuid) id: string, @Body(new ZodPipe(VoidSaleSchema)) body: z.infer<typeof VoidSaleSchema>) {
    return this.sales.void(req, id, body.reason);
  }

  @Post('refunds')
  @HttpCode(200)
  refund(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateRefundSchema)) body: z.infer<typeof CreateRefundSchema>) {
    return this.sales.refund(req, body);
  }

  @Get('refunds/:id/receipt')
  refundReceipt(@Req() req: RequestWithContext, @Param('id', uuid) id: string) {
    return this.receipts.forRefund(req.tenant!, id);
  }
}
