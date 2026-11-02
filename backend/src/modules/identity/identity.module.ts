import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { DevicesController } from './devices.controller.js';
import { DevicesService } from './devices.service.js';
import { LockoutService } from './lockout.service.js';
import { SessionService } from './session.service.js';

@Global()
@Module({
  controllers: [AuthController, DevicesController],
  providers: [AuthService, SessionService, LockoutService, DevicesService],
  exports: [SessionService, LockoutService],
})
export class IdentityModule {}
