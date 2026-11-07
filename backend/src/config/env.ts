import { Global, Module } from '@nestjs/common';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  PLATFORM_DOMAIN: z.string().min(3).toLowerCase(),
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  PII_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64'),
  PLATFORM_IP_ALLOWLIST: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
  /** Online invoice payments. Defaults to the sandbox outside production and to none in it. */
  BILLING_GATEWAY: z.enum(['none', 'sandbox', 'payhere']).optional(),
  PAYHERE_MERCHANT_ID: z.string().trim().min(1).optional(),
  PAYHERE_MERCHANT_SECRET: z.string().trim().min(1).optional(),
  /** true: sandbox.payhere.lk (free test merchant). Defaults to true outside production. */
  PAYHERE_SANDBOX: z.enum(['true', 'false']).optional(),
  /** Public URL PayHere posts notifications to: https://<api host>/api/platform/billing/webhooks/payhere */
  PAYHERE_NOTIFY_URL: z.url().optional(),
}).transform((e, ctx) => {
  const gateway = e.BILLING_GATEWAY ?? (e.NODE_ENV === 'production' ? 'none' : 'sandbox');
  if (gateway === 'sandbox' && e.NODE_ENV === 'production') {
    ctx.addIssue({ code: 'custom', path: ['BILLING_GATEWAY'], message: 'the sandbox gateway cannot run in production' });
  }
  if (gateway === 'payhere') {
    for (const k of ['PAYHERE_MERCHANT_ID', 'PAYHERE_MERCHANT_SECRET', 'PAYHERE_NOTIFY_URL'] as const) {
      if (!e[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required when BILLING_GATEWAY=payhere' });
    }
  }
  return { ...e, BILLING_GATEWAY: gateway, PAYHERE_SANDBOX: (e.PAYHERE_SANDBOX ?? (e.NODE_ENV === 'production' ? 'false' : 'true')) === 'true' };
});

export type Env = z.infer<typeof EnvSchema>;
export const ENV = Symbol('ENV');

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Only paths and messages: never echo values, they may be secrets.
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return result.data;
}

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
