import { Global, Module } from '@nestjs/common';
import { ModifiersService } from './modifiers.service.js';

@Global()
@Module({ providers: [ModifiersService], exports: [ModifiersService] })
export class ModifiersModule {}
