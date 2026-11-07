import { Module } from '@nestjs/common';
import { AnalyticsService } from '../reporting/analytics.service.js';
import { AnalyticsController, MultiStoreController, PurchasingController } from './business.controller.js';
import { PurchasingService } from './purchasing.service.js';
import { TransfersService } from './transfers.service.js';

@Module({
  controllers: [PurchasingController, MultiStoreController, AnalyticsController],
  providers: [PurchasingService, TransfersService, AnalyticsService],
})
export class BusinessModule {}
