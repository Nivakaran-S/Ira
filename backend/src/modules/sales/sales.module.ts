import { Module } from '@nestjs/common';
import { SalesController, ShiftsController } from './backoffice-sales.controller.js';
import { PosController } from './pos.controller.js';
import { ReceiptsService } from './receipts.service.js';
import { SalesService } from './sales.service.js';
import { ShiftsService } from './shifts.service.js';

@Module({
  controllers: [PosController, SalesController, ShiftsController],
  providers: [ShiftsService, SalesService, ReceiptsService],
  exports: [ShiftsService, SalesService, ReceiptsService],
})
export class SalesModule {}
