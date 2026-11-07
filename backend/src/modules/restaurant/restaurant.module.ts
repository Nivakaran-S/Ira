import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module.js';
import { KitchenController, ModifiersController, PosOrdersController, TablesController } from './restaurant.controller.js';
import { OrdersService } from './orders.service.js';

@Module({
  imports: [SalesModule],
  controllers: [ModifiersController, TablesController, PosOrdersController, KitchenController],
  providers: [OrdersService],
})
export class RestaurantModule {}
