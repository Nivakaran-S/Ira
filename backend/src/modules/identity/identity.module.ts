import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LockoutService } from './lockout.service.js';
import { SessionService } from './session.service.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, LockoutService],
  exports: [SessionService, LockoutService],
})
export class IdentityModule {}
