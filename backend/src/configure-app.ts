import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { correlationMiddleware } from './common/correlation.js';
import { ENV, type Env } from './config/env.js';
import { TenantResolverService } from './modules/access/tenant-resolver.service.js';

// Version cursors and sequence numbers are BIGINT; JSON carries them as decimal strings, losslessly.
(BigInt.prototype as unknown as { toJSON(): string }).toJSON = function (this: bigint) {
  return this.toString();
};

/** Everything main.ts and the test harness must configure identically. */
export function configureApp(app: NestExpressApplication) {
  const env = app.get<Env>(ENV);
  app.set('trust proxy', env.TRUST_PROXY.split(',').map((s) => s.trim()));
  app.disable('x-powered-by');
  app.setGlobalPrefix('api');
  app.use(correlationMiddleware);
  app.use(app.get(TenantResolverService).middleware);
  app.use(helmet());
  app.use(cookieParser());
  app.enableShutdownHooks();
}
