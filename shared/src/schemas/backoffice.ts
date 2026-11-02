import { z } from 'zod';
import { PERMISSIONS } from '../permissions.js';

export const CreateStoreSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().regex(/^[A-Z0-9]{2,8}$/),
});

export const CreateRegisterSchema = z.object({
  storeId: z.uuid(),
  name: z.string().trim().min(1).max(64),
  code: z.string().regex(/^[A-Z0-9]{1,6}$/),
});

export const CreateUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().transform((e) => e.toLowerCase()).optional(),
  roleIds: z.array(z.uuid()).min(1),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
});

export const SetPinSchema = z.object({ pin: z.string().regex(/^\d{4,8}$/) });

export const CreateRoleSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((n) => n.toLowerCase() !== 'owner', 'Owner is a reserved system role'),
  permissions: z.array(z.enum(PERMISSIONS)),
  requiresMfa: z.boolean().default(false),
});
