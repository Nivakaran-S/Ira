import { z } from 'zod';
import { MODULE_KEYS, missingDependencies } from '../modules.js';
import { PERMISSIONS } from '../permissions.js';

export const RESERVED_SLUGS = ['admin', 'api', 'www', 'app', 'static', 'mail', 'status'] as const;

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/, 'Lowercase letters, digits and hyphens; 2-32 chars')
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), 'Reserved slug');

const name = z.string().trim().min(1).max(120);

export const CreateTenantSchema = z.object({
  name,
  slug,
  businessTypeId: z.uuid(),
  planKey: z.string().min(1).default('standard'),
  ownerEmail: z.email().transform((e) => e.toLowerCase()),
  ownerName: name,
  country: z.string().length(2).toUpperCase().default('LK'),
  currency: z.string().length(3).toUpperCase().default('LKR'),
  timezone: z.string().min(1).default('Asia/Colombo'),
});

export const UpdateTenantStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) });

export const ChangeBusinessTypeSchema = z.object({ businessTypeId: z.uuid() });

const label = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const hostnameRe = new RegExp(`^(?:${label}\\.)+[a-z]{2,63}$`);

export const AddDomainSchema = z.object({
  hostname: z.string().trim().toLowerCase().max(253).regex(hostnameRe, 'Must be a bare hostname like shop.example.lk'),
});

export const RoleTemplateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine((n) => n.toLowerCase() !== 'owner', 'Owner is a reserved system role'),
  permissions: z.array(z.enum(PERMISSIONS)),
  requiresMfa: z.boolean(),
});

export const BusinessTypeSchema = z
  .object({
    key: slug,
    name,
    description: z.string().max(500).optional(),
    modules: z.array(z.enum(MODULE_KEYS)).min(1),
    roleTemplates: z.array(RoleTemplateSchema).min(1),
    defaultSettings: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((bt, ctx) => {
    const missing = missingDependencies(new Set(['core', ...bt.modules]) as Set<(typeof MODULE_KEYS)[number]>);
    if (missing.length) {
      ctx.addIssue({ code: 'custom', path: ['modules'], message: 'Unmet module dependencies', input: missing });
    }
  });

export const ModuleOverrideSchema = z.object({
  moduleKey: z.enum(MODULE_KEYS).refine((k) => k !== 'core', 'core cannot be overridden'),
  enabled: z.boolean(),
});

export const ImpersonateSchema = z.object({
  reason: z.string().trim().min(10).max(500),
  userId: z.uuid().optional(),
});
