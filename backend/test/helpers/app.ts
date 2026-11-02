import type { Type } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/configure-app.js';

export interface TestAppOptions {
  /** Extra controllers mounted only in tests (e.g. ProbeController). */
  controllers?: Type<unknown>[];
  /** Provider overrides (e.g. a fake DNS resolver). */
  customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule], controllers: options.controllers ?? [] });
  const moduleRef = await (options.customize ?? ((b) => b))(builder).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
  configureApp(app);
  await app.init();
  return app;
}
