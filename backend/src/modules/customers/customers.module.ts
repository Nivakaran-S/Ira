import { Global, Module } from '@nestjs/common';
import { CustomersController, PosCustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';
import { LedgersService } from './ledgers.service.js';

@Global()
@Module({ controllers: [CustomersController, PosCustomersController], providers: [CustomersService, LedgersService], exports: [CustomersService, LedgersService] })
export class CustomersModule {}
