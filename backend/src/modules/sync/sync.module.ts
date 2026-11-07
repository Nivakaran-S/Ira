import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module.js';
import { QuarantineController, SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

@Module({ imports: [SalesModule], controllers: [SyncController, QuarantineController], providers: [SyncService] })
export class SyncModule {}
