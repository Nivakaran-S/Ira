import { Module } from '@nestjs/common';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformSessionService } from './platform-session.service.js';

@Module({
  controllers: [PlatformAuthController],
  providers: [PlatformAuthService, PlatformSessionService],
})
export class PlatformModule {}
