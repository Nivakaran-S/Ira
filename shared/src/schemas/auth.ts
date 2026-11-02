import { z } from 'zod';
import { PERMISSIONS } from '../permissions.js';

const pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4-8 digits');

export const LoginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(1).max(256),
});

export const MfaVerifySchema = z.object({
  mfaToken: z.string().min(1).max(4096),
  code: z.string().regex(/^\d{6}$/),
});

export const SetupPasswordSchema = z.object({
  code: z.string().min(16).max(128),
  password: z.string().min(12, 'Password must be at least 12 characters').max(256),
});

export const PinLoginSchema = z.object({ userId: z.uuid(), pin });

export const StepUpSchema = z.object({
  approverUserId: z.uuid(),
  pin,
  action: z.enum(PERMISSIONS),
});

export const CreateEnrollmentSchema = z.object({ registerId: z.uuid() });

export const EnrollDeviceSchema = z.object({
  code: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/),
  name: z.string().trim().min(1).max(64),
  publicKeyJwk: z.object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().min(40).max(48),
    y: z.string().min(40).max(48),
  }),
});
