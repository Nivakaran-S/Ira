import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { MeController } from './me.controller.js';
import { OrgService } from './org.service.js';
import { RegistersController } from './registers.controller.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { StoresController } from './stores.controller.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [MeController, StoresController, RegistersController, RolesController, UsersController, AuditController],
  providers: [OrgService, RolesService, UsersService],
})
export class BackofficeModule {}
