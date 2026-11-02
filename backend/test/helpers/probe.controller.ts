import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { RequestWithContext } from '../../src/common/request-context.js';
import {
  Public, Realm, RequiresDevice, RequiresModule, RequiresPermission, RequiresStepUp,
} from '../../src/modules/access/decorators.js';

@Controller('probe')
export class ProbeController {
  @Public() @Get('tenant')
  tenant(@Req() req: RequestWithContext) {
    return { realm: req.hostRealm, tenantId: req.tenant?.id ?? null };
  }

  @Public() @Realm('platform') @Get('platform')
  platform() {
    return { ok: true };
  }

  @Public() @Realm('any') @Get('any')
  any(@Req() req: RequestWithContext) {
    return { realm: req.hostRealm };
  }

  @Get('authed')
  authed(@Req() req: RequestWithContext) {
    return req.principal;
  }

  @Realm('platform') @Get('platform-authed')
  platformAuthed(@Req() req: RequestWithContext) {
    return req.principal;
  }

  @RequiresModule('tables') @Get('tables')
  tables() {
    return { ok: true };
  }

  @RequiresPermission('sale.refund') @Get('refund-permission')
  refundPermission() {
    return { ok: true };
  }

  @RequiresDevice() @RequiresPermission('sale.create') @Post('device-sale') @HttpCode(200)
  deviceSale(@Req() req: RequestWithContext) {
    return { device: req.device, principal: req.principal };
  }

  @RequiresDevice() @RequiresStepUp('sale.refund') @Post('refund') @HttpCode(200)
  refund() {
    return { refunded: true };
  }
}
