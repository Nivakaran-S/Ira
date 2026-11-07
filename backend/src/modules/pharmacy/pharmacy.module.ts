import { Global, Module } from '@nestjs/common';
import { BatchesService } from './batches.service.js';
import { BatchesController, PosPrescriptionsController, PrescriptionsController } from './pharmacy.controller.js';
import { PrescriptionsService } from './prescriptions.service.js';

@Global()
@Module({
  controllers: [BatchesController, PrescriptionsController, PosPrescriptionsController],
  providers: [BatchesService, PrescriptionsService],
  exports: [BatchesService, PrescriptionsService],
})
export class PharmacyModule {}
