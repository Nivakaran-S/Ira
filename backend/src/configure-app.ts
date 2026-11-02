import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { correlationMiddleware } from './common/correlation.js';
import { ENV, type Env } from './config/env.js';

/** Everything main.ts and the test harness must configure identically. */
export function configureApp(app: NestExpressApplication) {
  const env = app.get<Env>(ENV);
  app.set('trust proxy', env.TRUST_PROXY.split(',').map((s) => s.trim()));
  app.disable('x-powered-by');
  app.setGlobalPrefix('api');
  app.use(correlationMiddleware);
  app.use(helmet());
  app.use(cookieParser());
  app.enableShutdownHooks();
}
