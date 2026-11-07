import { Global, Module } from '@nestjs/common';
import { PromotionsController } from './promotions.controller.js';
import { PromotionsService } from './promotions.service.js';

@Global()
@Module({ controllers: [PromotionsController], providers: [PromotionsService], exports: [PromotionsService] })
export class PromotionsModule {}
