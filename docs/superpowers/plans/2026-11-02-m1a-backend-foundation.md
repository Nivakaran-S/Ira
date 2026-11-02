# Milestone 1a — Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running, tested NestJS API that gives the POS platform its zero-trust foundation: multi-tenant data isolated by Postgres RLS, host-based tenant resolution, password+MFA, PIN and device-signed authentication, granular permissions with step-up, a hash-chained audit log, and a super-admin API for tenants, domains, business types, and modules.

**Architecture:** npm-workspaces monorepo. `shared/` holds types, Zod schemas, the module and permission registries, and the device-signing payload format (later reused by the Angular apps). `backend/` is a NestJS 12 (ESM) modular monolith on Prisma 7 + PostgreSQL 16 + Redis 7. Every tenant-scoped query runs inside `TenantDb.run(tenantId, tx => …)`, which sets `app.tenant_id` for the transaction so RLS filters at the database. A chain of global guards (realm → auth → device → tenant status → module → permission → step-up) runs on every request.

**Tech Stack:** Node ≥22 (dev machine has 26), TypeScript 5.9, NestJS 12 (ESM), Prisma 7 with `@prisma/adapter-pg`, PostgreSQL 16, Redis 7 (ioredis), Zod 4, jose (EdDSA JWT), @node-rs/argon2, Vitest 3 + unplugin-swc, supertest, Docker Compose, Caddy 2.

**Spec:** `docs/superpowers/specs/2026-11-02-pos-platform-design.md` (this plan implements §2–§6 and §9 for Milestone 1; the Angular admin UI is Plan 1b).

## Global Constraints

- Repo layout exactly as spec §2: `backend/`, `shared/`, `infra/`, `docs/` at the root; npm workspaces from the root `package.json`.
- All packages are ESM (`"type": "module"`). TypeScript `module`/`moduleResolution` = `nodenext`; relative imports end in `.js`.
- PostgreSQL 16. App connects as role `pos_app` (`NOBYPASSRLS`, not table owner). Migrations and tests' fixture setup connect as `pos_owner`.
- Every table with a `tenantId` column has RLS enabled with policy `tenant_isolation` comparing to `NULLIF(current_setting('app.tenant_id', true), '')::uuid`.
- Primary keys: UUIDv7 (`@default(uuid(7))` in Prisma, `uuid` package `v7()` in code).
- Access JWT: EdDSA (Ed25519), issuer `pos`, 300 s TTL. Audiences: `tenant`, `platform`, `mfa`, `step-up`.
- Refresh token: opaque, rotating, cookie `pos_rt`, httpOnly, Secure, SameSite=Strict, path `/api/auth` (tenant) or `/api/platform/auth` (platform); idle 12 h, absolute 7 days; reuse revokes the family.
- Device signature: ECDSA P-256 / SHA-256 over `METHOD\npath\nsha256hex(body)\nts\nnonce`; headers `x-device-id`, `x-device-ts` (unix seconds), `x-device-nonce`, `x-device-sig` (base64url, IEEE P1363); clock skew ±120 s; nonce single-use for 300 s.
- Lockouts: 5 consecutive failures → 15 min lock (password, PIN, super-admin login).
- Enrollment code: 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, 10 min TTL, single use.
- Impersonation: reason ≥ 10 chars, token lifetime 1800 s, audited in both platform and tenant logs.
- Error body everywhere: `{ code, message, details?, correlationId }`; no stack traces in responses.
- Money is out of scope for this plan; no floats are introduced anywhere.
- Never log or print secrets (passwords, PINs, TOTP secrets, tokens, keys). Setup codes are printed once only by the bootstrap script and returned once by the create-tenant / create-user APIs.

## Review Focus

1. **Cross-tenant foreign keys**: a user of tenant A submits an id belonging to tenant B (e.g. `storeId` when creating a register). Expected: rejected, because tenant-scoped relations are composite `(tenantId, id)` FKs; FK checks ignore RLS, so a plain `storeId` FK would silently link across tenants. Pinned in Task 4 (`rls.spec.ts` → "composite FK blocks cross-tenant reference").
2. **Tenant context leaking through the connection pool**: a query run after `TenantDb.run` on a reused pooled connection. Expected: sees zero tenant rows (`set_config(..., true)` is transaction-local). Pinned in Task 5 (`tenant-db.spec.ts` → "context does not leak to the next query on the pool").
3. **Privilege escalation by role managers**: a manager with `role.manage` + `user.manage` but without `sale.refund` creates a role containing `sale.refund` and assigns it to themself. Expected: 403; you can only grant permissions you hold. Pinned in Task 18.
4. **Concurrent refresh / concurrent audit writes**: two refreshes of the same token at once, two audit events for one tenant at once. Expected: exactly one refresh succeeds (the other is treated as reuse); the audit chain stays linear and verifiable. Pinned in Task 9 ("concurrent refresh") and Task 7 ("concurrent writes keep a linear chain").
5. **TOTP code replay and module-dependency drift**: the same 6-digit code used twice in its 30 s window; a business type later dropping `modifiers` while a tenant override enables `kitchen-display`. Expected: the replayed code is rejected; the resolved module set auto-drops modules with unmet dependencies instead of exposing a broken feature. Pinned in Task 6 ("rejects a replayed counter") and Task 2 ("drops modules whose dependencies are missing").

## Deviations from the spec (deliberate)

- **Permissions and modules are code registries** (`shared/src/permissions.ts`, `shared/src/modules.ts`), not `Permission` / `Module` tables. Both are tied to code that enforces them; a database row could not add behaviour. Roles store permission keys (`Role.permissions String[]`); business types store module keys (`BusinessType.modules String[]`) instead of a `BusinessTypeModule` join table.
- **Explicit `TenantDb.run(tenantId, tx => …)` instead of a request-wide transaction interceptor** (spec §3 step 8). Same guarantee (transaction-local `app.tenant_id`, RLS-filtered), but the transaction scope is visible at each call site and slow work such as argon2 hashing stays outside it.
- **Domain re-verification uses `@nestjs/schedule`**, not BullMQ. One daily job does not need a queue; BullMQ arrives with the first real background workload.

---

## File Map

```
POS/
├── package.json                         workspaces root, orchestration scripts
├── .gitignore                           (modify) allow committed .env.test
├── README.md                            (replace) how to run
├── infra/
│   ├── docker-compose.yml               postgres 16, redis 7, caddy (profile "edge")
│   ├── postgres/init/01-roles.sql       pos_owner / pos_app roles, pos + pos_test DBs
│   └── caddy/Caddyfile                  dev edge: on-demand TLS, /api → backend
├── shared/
│   ├── package.json, tsconfig.json, vitest.config.ts
│   └── src/
│       ├── index.ts                     barrel
│       ├── errors.ts                    ERROR_CODES, ApiErrorBody
│       ├── modules.ts                   MODULES registry, resolveModules, missingDependencies
│       ├── permissions.ts               PERMISSIONS
│       ├── device-signing.ts            buildSigningPayload, DEVICE_HEADERS
│       └── schemas/{auth,platform,backoffice}.ts   Zod request schemas
└── backend/
    ├── package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, prisma.config.ts
    ├── .env.example, .env.test
    ├── scripts/gen-dev-env.ts           writes backend/.env with fresh keys
    ├── scripts/create-super-admin.ts    bootstrap first super admin
    ├── prisma/schema.prisma, prisma/seed.ts, prisma/migrations/…
    ├── src/
    │   ├── main.ts, app.module.ts, configure-app.ts
    │   ├── config/env.ts                Zod env loader, ENV token, ConfigModule
    │   ├── common/
    │   │   ├── errors/app-error.ts, errors/app-error.filter.ts
    │   │   ├── correlation.ts           correlation-id middleware
    │   │   ├── zod.pipe.ts
    │   │   ├── request-context.ts       RequestWithContext, Principal, TenantContext
    │   │   └── crypto/{aead,hash,base32,totp,canonical-json}.ts
    │   ├── infra/{prisma.service,tenant-db.service,redis.service,rate-limiter,infra.module}.ts
    │   ├── modules/
    │   │   ├── health/health.controller.ts
    │   │   ├── audit/{audit.service,audit.module}.ts
    │   │   ├── access/                  decorators, tenant resolver, guards, capabilities
    │   │   ├── identity/                password, token, sessions, auth, devices, step-up
    │   │   ├── platform/                super-admin auth, tenants, business types, domains, caddy, impersonation
    │   │   └── backoffice/              me, stores, registers, users, roles, audit view
    │   └── generated/prisma/            (generated, git-ignored)
    └── test/
        ├── global-setup.ts, setup-env.ts
        └── helpers/{db,fixtures,app,device,totp}.ts
```

---

### Task 1: Monorepo root and local infrastructure

**Files:**
- Create: `package.json`, `infra/docker-compose.yml`, `infra/postgres/init/01-roles.sql`
- Modify: `.gitignore`

**Interfaces:**
- Produces: Postgres on `localhost:5432` with databases `pos` and `pos_test`, roles `pos_owner` (password `pos_owner_dev`, CREATEDB) and `pos_app` (password `pos_app_dev`, NOBYPASSRLS); Redis on `localhost:6379`. Root scripts `infra:up`, `infra:down`, `test`, `build:shared`.

- [ ] **Step 1: Write the root `package.json`**

```json
{
  "name": "pos-platform",
  "private": true,
  "type": "module",
  "workspaces": ["shared", "backend"],
  "engines": { "node": ">=22" },
  "scripts": {
    "infra:up": "docker compose -f infra/docker-compose.yml up -d --wait",
    "infra:down": "docker compose -f infra/docker-compose.yml down",
    "build:shared": "npm run build -w shared",
    "dev:api": "npm run build:shared && npm run start:dev -w backend",
    "test": "npm run test -w shared && npm run test -w backend"
  }
}
```

- [ ] **Step 2: Write `infra/postgres/init/01-roles.sql`**

```sql
-- Runs once, on first container start, as the postgres superuser.
CREATE ROLE pos_owner LOGIN PASSWORD 'pos_owner_dev' CREATEDB;
CREATE ROLE pos_app LOGIN PASSWORD 'pos_app_dev' NOBYPASSRLS;

CREATE DATABASE pos OWNER pos_owner;
CREATE DATABASE pos_test OWNER pos_owner;

\c pos
ALTER SCHEMA public OWNER TO pos_owner;
GRANT USAGE ON SCHEMA public TO pos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pos_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pos_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pos_app;

\c pos_test
ALTER SCHEMA public OWNER TO pos_owner;
GRANT USAGE ON SCHEMA public TO pos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pos_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE pos_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO pos_app;
```

- [ ] **Step 3: Write `infra/docker-compose.yml`**

```yaml
name: pos
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres_dev
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d pos"]
      interval: 3s
      retries: 20
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      retries: 20
  caddy:
    image: caddy:2-alpine
    profiles: ["edge"]
    ports: ["80:80", "443:443"]
    extra_hosts: ["host.docker.internal:host-gateway"]
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
volumes:
  pgdata: {}
  caddydata: {}
```

- [ ] **Step 4: Allow the committed test env file**

Append to `.gitignore`:

```
!.env.test
backend/src/generated/
```

- [ ] **Step 5: Start infra and verify roles**

Run: `npm run infra:up`
Then: `docker compose -f infra/docker-compose.yml exec -T postgres psql -U postgres -d pos -tAc "select rolname, rolbypassrls from pg_roles where rolname in ('pos_app','pos_owner') order by 1"`
Expected:
```
pos_app|f
pos_owner|f
```
Then: `docker compose -f infra/docker-compose.yml exec -T redis redis-cli ping` → `PONG`.

If port 5432 or 6379 is already in use on the machine, change only the host side of the mapping (e.g. `"55432:5432"`) and use that port in every URL in this plan.

- [ ] **Step 6: Commit**

```bash
git add package.json infra/ .gitignore
git commit -m "chore: monorepo root and local postgres/redis infra"
```

---

### Task 2: `shared` package — registries, error contract, schemas

**Files:**
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/vitest.config.ts`
- Create: `shared/src/index.ts`, `shared/src/errors.ts`, `shared/src/modules.ts`, `shared/src/permissions.ts`, `shared/src/device-signing.ts`
- Create: `shared/src/schemas/auth.ts`, `shared/src/schemas/platform.ts`, `shared/src/schemas/backoffice.ts`
- Test: `shared/src/modules.spec.ts`, `shared/src/schemas/platform.spec.ts`, `shared/src/device-signing.spec.ts`

**Interfaces:**
- Produces (all exported from `@pos/shared`):
  - `ERROR_CODES`, `type ErrorCode`, `interface ApiErrorBody { code: ErrorCode; message: string; details?: unknown; correlationId: string }`
  - `MODULES`, `type ModuleKey`, `MODULE_KEYS`, `isModuleKey(k: string): k is ModuleKey`, `interface ModuleOverride { moduleKey: string; enabled: boolean }`, `applyOverrides(base, overrides): Set<ModuleKey>`, `resolveModules(base: readonly string[], overrides?: readonly ModuleOverride[]): ModuleKey[]`, `missingDependencies(keys: Iterable<ModuleKey>): { module: ModuleKey; requires: ModuleKey }[]`
  - `PERMISSIONS`, `type Permission`
  - `DEVICE_HEADERS`, `buildSigningPayload(method, path, bodySha256Hex, ts, nonce): string`
  - Schemas: `LoginSchema`, `MfaVerifySchema`, `SetupPasswordSchema`, `PinLoginSchema`, `StepUpSchema`, `CreateEnrollmentSchema`, `EnrollDeviceSchema`, `RESERVED_SLUGS`, `CreateTenantSchema`, `UpdateTenantStatusSchema`, `ChangeBusinessTypeSchema`, `AddDomainSchema`, `RoleTemplateSchema`, `BusinessTypeSchema`, `ModuleOverrideSchema`, `ImpersonateSchema`, `CreateStoreSchema`, `CreateRegisterSchema`, `CreateUserSchema`, `SetPinSchema`, `CreateRoleSchema`

- [ ] **Step 1: Package files**

`shared/package.json`:
```json
{
  "name": "@pos/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  }
}
```

`shared/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "lib": ["ES2023", "DOM"]
  },
  "include": ["src"],
  "exclude": ["src/**/*.spec.ts"]
}
```

`shared/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.spec.ts'] } });
```

Run: `npm install -w shared zod@^4 && npm install -D -w shared typescript@~5.9 vitest@^3.2`

- [ ] **Step 2: Write the failing tests**

`shared/src/modules.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MODULES, MODULE_KEYS, missingDependencies, resolveModules } from './modules.js';

describe('module registry', () => {
  it('every dependency refers to a registered module', () => {
    for (const key of MODULE_KEYS) {
      for (const dep of MODULES[key].requires) expect(MODULE_KEYS).toContain(dep);
    }
  });
});

describe('resolveModules', () => {
  it('always includes core', () => {
    expect(resolveModules([])).toEqual(['core']);
  });

  it('applies enable and disable overrides on top of the base set', () => {
    const result = resolveModules(['core', 'tables', 'customers'], [
      { moduleKey: 'tables', enabled: false },
      { moduleKey: 'barcodes', enabled: true },
    ]);
    expect(result).toEqual(['barcodes', 'core', 'customers']);
  });

  it('drops modules whose dependencies are missing', () => {
    // kitchen-display requires modifiers; prescriptions requires batch-expiry + customers
    expect(resolveModules(['kitchen-display', 'prescriptions', 'customers'])).toEqual(['core', 'customers']);
  });

  it('cascades drops through chains of dependencies', () => {
    expect(resolveModules(['tables', 'split-bill'], [{ moduleKey: 'tables', enabled: false }])).toEqual(['core']);
  });

  it('ignores unknown module keys', () => {
    expect(resolveModules(['core', 'teleporter'], [{ moduleKey: 'warp', enabled: true }])).toEqual(['core']);
  });

  it('cannot disable core', () => {
    expect(resolveModules(['core'], [{ moduleKey: 'core', enabled: false }])).toEqual(['core']);
  });
});

describe('missingDependencies', () => {
  it('lists each unmet dependency', () => {
    expect(missingDependencies(['core', 'kitchen-display'])).toEqual([{ module: 'kitchen-display', requires: 'modifiers' }]);
  });
  it('returns empty for a closed set', () => {
    expect(missingDependencies(['core', 'modifiers', 'kitchen-display'])).toEqual([]);
  });
});
```

`shared/src/schemas/platform.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AddDomainSchema, BusinessTypeSchema, CreateTenantSchema } from './platform.js';

const validTenant = {
  name: 'Acme Stores',
  slug: 'acme',
  businessTypeId: '0190b6a0-0000-7000-8000-000000000001',
  ownerEmail: 'owner@acme.lk',
  ownerName: 'Acme Owner',
};

describe('CreateTenantSchema', () => {
  it('applies Sri Lanka defaults', () => {
    const t = CreateTenantSchema.parse(validTenant);
    expect(t).toMatchObject({ country: 'LK', currency: 'LKR', timezone: 'Asia/Colombo', planKey: 'standard' });
  });
  it.each(['admin', 'api', 'Acme', 'a', '-acme', 'acme-', 'ac.me'])('rejects slug %s', (slug) => {
    expect(CreateTenantSchema.safeParse({ ...validTenant, slug }).success).toBe(false);
  });
});

describe('BusinessTypeSchema', () => {
  const base = {
    key: 'cafe',
    name: 'Café',
    modules: ['core', 'modifiers', 'kitchen-display'],
    roleTemplates: [{ name: 'Cashier', permissions: ['sale.create'], requiresMfa: false }],
  };
  it('accepts a dependency-closed module set', () => {
    expect(BusinessTypeSchema.safeParse(base).success).toBe(true);
  });
  it('rejects modules with unmet dependencies', () => {
    const r = BusinessTypeSchema.safeParse({ ...base, modules: ['core', 'kitchen-display'] });
    expect(r.success).toBe(false);
  });
  it('rejects a role template named Owner (reserved for the system role)', () => {
    const r = BusinessTypeSchema.safeParse({
      ...base,
      roleTemplates: [{ name: ' owner ', permissions: [], requiresMfa: true }],
    });
    expect(r.success).toBe(false);
  });
  it('rejects unknown permissions', () => {
    const r = BusinessTypeSchema.safeParse({
      ...base,
      roleTemplates: [{ name: 'Cashier', permissions: ['launch.missiles'], requiresMfa: false }],
    });
    expect(r.success).toBe(false);
  });
});

describe('AddDomainSchema', () => {
  it('lowercases the hostname', () => {
    expect(AddDomainSchema.parse({ hostname: 'Shop.Example.LK' }).hostname).toBe('shop.example.lk');
  });
  it.each(['localhost', 'https://shop.lk', 'shop.lk/path', 'shop..lk', '-shop.lk'])('rejects %s', (hostname) => {
    expect(AddDomainSchema.safeParse({ hostname }).success).toBe(false);
  });
});
```

`shared/src/device-signing.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildSigningPayload } from './device-signing.js';

describe('buildSigningPayload', () => {
  it('joins upper-cased method, path, body hash, ts and nonce with newlines', () => {
    expect(buildSigningPayload('post', '/api/auth/pin?x=1', 'abc', '1700000000', 'n1')).toBe(
      'POST\n/api/auth/pin?x=1\nabc\n1700000000\nn1',
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w shared`
Expected: FAIL — `Cannot find module './modules.js'` (and the other two).

- [ ] **Step 4: Implement**

`shared/src/errors.ts`:
```ts
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'TENANT_SUSPENDED',
  'TENANT_MISMATCH',
  'MODULE_DISABLED',
  'PLAN_LIMIT_REACHED',
  'DEVICE_SIGNATURE_INVALID',
  'DEVICE_REVOKED',
  'STEP_UP_REQUIRED',
  'ACCOUNT_LOCKED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
  correlationId: string;
}
```

`shared/src/modules.ts`:
```ts
interface ModuleDef {
  readonly name: string;
  readonly requires: readonly string[];
}

export const MODULES = {
  core: { name: 'Core POS', requires: [] },
  customers: { name: 'Customers', requires: [] },
  variants: { name: 'Product variants', requires: [] },
  barcodes: { name: 'Barcodes & scanning', requires: [] },
  promotions: { name: 'Promotions', requires: [] },
  loyalty: { name: 'Loyalty', requires: ['customers'] },
  tables: { name: 'Tables', requires: [] },
  modifiers: { name: 'Modifiers', requires: [] },
  'kitchen-display': { name: 'Kitchen display', requires: ['modifiers'] },
  'split-bill': { name: 'Split bill', requires: ['tables'] },
  'weighed-items': { name: 'Weighed items', requires: [] },
  'batch-expiry': { name: 'Batch & expiry', requires: [] },
  prescriptions: { name: 'Prescriptions', requires: ['batch-expiry', 'customers'] },
  'multi-store': { name: 'Multi-store', requires: [] },
  purchasing: { name: 'Purchasing', requires: [] },
} as const satisfies Record<string, ModuleDef>;

export type ModuleKey = keyof typeof MODULES;
export const MODULE_KEYS = Object.keys(MODULES) as [ModuleKey, ...ModuleKey[]];

export interface ModuleOverride {
  moduleKey: string;
  enabled: boolean;
}

export function isModuleKey(key: string): key is ModuleKey {
  return Object.hasOwn(MODULES, key);
}

function requiresOf(key: ModuleKey): readonly ModuleKey[] {
  return MODULES[key].requires as readonly ModuleKey[];
}

/** Base set + overrides, without dependency pruning. Always contains core. */
export function applyOverrides(base: readonly string[], overrides: readonly ModuleOverride[] = []): Set<ModuleKey> {
  const set = new Set<ModuleKey>();
  for (const key of base) if (isModuleKey(key)) set.add(key);
  for (const o of overrides) {
    if (!isModuleKey(o.moduleKey)) continue;
    if (o.enabled) set.add(o.moduleKey);
    else set.delete(o.moduleKey);
  }
  set.add('core');
  return set;
}

/** The modules a tenant actually gets: overrides applied, modules with unmet dependencies dropped. */
export function resolveModules(base: readonly string[], overrides: readonly ModuleOverride[] = []): ModuleKey[] {
  const set = applyOverrides(base, overrides);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...set]) {
      if (requiresOf(key).some((dep) => !set.has(dep))) {
        set.delete(key);
        changed = true;
      }
    }
  }
  return [...set].sort();
}

export function missingDependencies(keys: Iterable<ModuleKey>): { module: ModuleKey; requires: ModuleKey }[] {
  const set = new Set(keys);
  const missing: { module: ModuleKey; requires: ModuleKey }[] = [];
  for (const key of set) {
    for (const dep of requiresOf(key)) if (!set.has(dep)) missing.push({ module: key, requires: dep });
  }
  return missing;
}
```

`shared/src/permissions.ts`:
```ts
export const PERMISSIONS = [
  'store.manage',
  'register.manage',
  'user.manage',
  'role.manage',
  'device.enroll',
  'device.revoke',
  'audit.view',
  'sale.create',
  'sale.void',
  'sale.refund',
  'price.override',
  'discount.apply',
  'drawer.open',
  'shift.close',
  'stock.adjust',
  'report.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
```

`shared/src/device-signing.ts`:
```ts
export const DEVICE_HEADERS = {
  id: 'x-device-id',
  ts: 'x-device-ts',
  nonce: 'x-device-nonce',
  sig: 'x-device-sig',
} as const;

/** The exact string a device signs. Path includes the query string, as sent. */
export function buildSigningPayload(method: string, path: string, bodySha256Hex: string, ts: string, nonce: string): string {
  return [method.toUpperCase(), path, bodySha256Hex, ts, nonce].join('\n');
}
```

`shared/src/schemas/auth.ts`:
```ts
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
```

`shared/src/schemas/platform.ts`:
```ts
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
```

`shared/src/schemas/backoffice.ts`:
```ts
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
```

`shared/src/index.ts`:
```ts
export * from './errors.js';
export * from './modules.js';
export * from './permissions.js';
export * from './device-signing.js';
export * from './schemas/auth.js';
export * from './schemas/platform.js';
export * from './schemas/backoffice.js';
```

- [ ] **Step 5: Run tests to verify they pass, then build**

Run: `npm test -w shared` → all PASS.
Run: `npm run build -w shared` → emits `shared/dist/` with no errors.

- [ ] **Step 6: Commit**

```bash
git add shared/ package-lock.json package.json
git commit -m "feat(shared): module/permission registries, error contract, request schemas"
```

---

### Task 3: Backend scaffold — env, errors, correlation id, health, test harness

**Files:**
- Create: `backend/package.json`, `backend/tsconfig.json`, `backend/tsconfig.build.json`, `backend/vitest.config.ts`
- Create: `backend/.env.example`, `backend/.env.test`, `backend/scripts/gen-dev-env.ts`
- Create: `backend/src/main.ts`, `backend/src/app.module.ts`, `backend/src/configure-app.ts`
- Create: `backend/src/config/env.ts`
- Create: `backend/src/common/errors/app-error.ts`, `backend/src/common/errors/app-error.filter.ts`, `backend/src/common/correlation.ts`, `backend/src/common/zod.pipe.ts`, `backend/src/common/request-context.ts`
- Create: `backend/src/modules/health/health.controller.ts`
- Create: `backend/test/setup-env.ts`, `backend/test/global-setup.ts`, `backend/test/helpers/app.ts`
- Test: `backend/src/config/env.spec.ts`, `backend/test/health.e2e.spec.ts`

**Interfaces:**
- Consumes: `@pos/shared` (`ErrorCode`, `ApiErrorBody`).
- Produces:
  - `loadEnv(source?: NodeJS.ProcessEnv): Env`, `type Env`, `ENV` (injection token, `Symbol('ENV')`), `ConfigModule` (global, provides `ENV`).
  - `class AppError extends Error { code: ErrorCode; status: number; details?: unknown }` with statics `unauthenticated(msg?)`, `forbidden(msg?)`, `notFound(msg?)`, `conflict(msg, details?)`, `validation(details)`, `rateLimited()`, and constructor `new AppError(code, status, message, details?)`.
  - `AppErrorFilter` (global `@Catch()`).
  - `correlationMiddleware(req, res, next)`.
  - `ZodPipe` (`new ZodPipe(schema)`).
  - `RequestWithContext`, `Principal`, `TenantContext`, `HostRealm` types.
  - `configureApp(app: NestExpressApplication): void`.
  - Test helper `createTestApp(options?: { controllers?: Type[]; customize?: (b: TestingModuleBuilder) => TestingModuleBuilder }): Promise<NestExpressApplication>`.

- [ ] **Step 1: Package files and install**

`backend/package.json`:
```json
{
  "name": "@pos/backend",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "start:dev": "concurrently -k -n tsc,api \"tsc -p tsconfig.build.json --watch --preserveWatchOutput\" \"node --watch-path=dist --env-file=.env dist/main.js\"",
    "test": "vitest run",
    "test:watch": "vitest",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:deploy": "prisma migrate deploy",
    "db:seed": "prisma db seed",
    "env:dev": "tsx scripts/gen-dev-env.ts",
    "platform:create-admin": "tsx --env-file=.env scripts/create-super-admin.ts"
  }
}
```

`backend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "sourceMap": true,
    "lib": ["ES2023", "DOM"]
  },
  "include": ["src", "test", "scripts", "prisma", "prisma.config.ts", "vitest.config.ts"]
}
```

`backend/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "exclude": ["src/**/*.spec.ts"]
}
```

`backend/vitest.config.ts`:
```ts
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@pos/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    setupFiles: ['test/setup-env.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
  // SWC (not esbuild) so Nest's decorator metadata is emitted.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
```

Install:
```bash
npm install -w backend @nestjs/common@^12 @nestjs/core@^12 @nestjs/platform-express@^12 @nestjs/schedule reflect-metadata rxjs helmet cookie-parser ioredis@^5 jose @node-rs/argon2 @prisma/client@^7 @prisma/adapter-pg@^7 uuid zod@^4 dotenv "@pos/shared@*"
npm install -D -w backend @nestjs/testing@^12 typescript@~5.9 prisma@^7 vitest@^3.2 unplugin-swc @swc/core supertest @types/supertest @types/express @types/cookie-parser @types/node tsx concurrently
```

Pinned majors are deliberate. As of 2026-11-02 the registry's `latest` tag for `prisma` points at an 8.0 release candidate while `@prisma/client` is 7.10.x (the two must share a major); `typescript` latest is 7.0 (the Go port), and this plan stays on 5.9 for `emitDecoratorMetadata`, which Nest DI relies on; `ioredis` latest is 6.0, and the code here uses the 5.x API. Do not bump these majors inside this plan.

- [ ] **Step 2: Env files**

`backend/.env.example` (committed; real `.env` is generated by `npm run env:dev -w backend`):
```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://pos_app:pos_app_dev@localhost:5432/pos
DATABASE_OWNER_URL=postgresql://pos_owner:pos_owner_dev@localhost:5432/pos
REDIS_URL=redis://localhost:6379/0
PLATFORM_DOMAIN=pos.localhost
# base64 of PEM; generated by scripts/gen-dev-env.ts
JWT_PRIVATE_KEY=
JWT_PUBLIC_KEY=
# base64 of 32 random bytes
PII_KEY=
# optional comma-separated IPs allowed on the super-admin host
PLATFORM_IP_ALLOWLIST=
TRUST_PROXY=loopback,uniquelocal
```

`backend/.env.test` (committed; contains no secrets — keys are generated per test run in `setup-env.ts`):
```
NODE_ENV=test
PORT=0
DATABASE_URL=postgresql://pos_app:pos_app_dev@localhost:5432/pos_test
DATABASE_OWNER_URL=postgresql://pos_owner:pos_owner_dev@localhost:5432/pos_test
REDIS_URL=redis://localhost:6379/1
PLATFORM_DOMAIN=pos.localhost
PLATFORM_IP_ALLOWLIST=
TRUST_PROXY=loopback,uniquelocal
```

`backend/scripts/gen-dev-env.ts`:
```ts
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const target = new URL('../.env', import.meta.url);
const example = new URL('../.env.example', import.meta.url);

if (existsSync(target)) {
  console.log('backend/.env already exists; leaving it untouched.');
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (s: string) => Buffer.from(s).toString('base64');
const values: Record<string, string> = {
  JWT_PRIVATE_KEY: b64(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
  JWT_PUBLIC_KEY: b64(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  PII_KEY: randomBytes(32).toString('base64'),
};

const out = readFileSync(example, 'utf8')
  .split('\n')
  .map((line) => {
    const key = line.split('=')[0];
    return key && key in values ? `${key}=${values[key]}` : line;
  })
  .join('\n');

writeFileSync(target, out, { mode: 0o600 });
console.log('Wrote backend/.env with fresh JWT keys and PII key.');
```

- [ ] **Step 3: Write the failing tests**

`backend/src/config/env.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379/0',
  PLATFORM_DOMAIN: 'pos.localhost',
  JWT_PRIVATE_KEY: 'x',
  JWT_PUBLIC_KEY: 'y',
  PII_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadEnv', () => {
  it('parses a valid environment with defaults', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(3000);
    expect(env.PLATFORM_IP_ALLOWLIST).toEqual([]);
  });

  it('splits the IP allowlist', () => {
    expect(loadEnv({ ...valid, PLATFORM_IP_ALLOWLIST: '1.2.3.4, 5.6.7.8' }).PLATFORM_IP_ALLOWLIST).toEqual(['1.2.3.4', '5.6.7.8']);
  });

  it('rejects a PII key that is not 32 bytes, without echoing the value', () => {
    const secret = Buffer.alloc(16, 7).toString('base64');
    expect(() => loadEnv({ ...valid, PII_KEY: secret })).toThrowError(/PII_KEY/);
    try {
      loadEnv({ ...valid, PII_KEY: secret });
    } catch (e) {
      expect(String(e)).not.toContain(secret);
    }
  });
});
```

`backend/test/health.e2e.spec.ts`:
```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';

describe('health and error contract', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns ok with a correlation id header', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a well-formed incoming correlation id', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').set('x-correlation-id', 'abc12345-req').expect(200);
    expect(res.headers['x-correlation-id']).toBe('abc12345-req');
  });

  it('replaces a malformed incoming correlation id', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').set('x-correlation-id', 'bad id\n<script>').expect(200);
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('unknown routes return the error contract', async () => {
    const res = await request(app.getHttpServer()).get('/api/nope').expect(404);
    expect(res.body).toEqual({ code: 'NOT_FOUND', message: 'Not found', correlationId: res.headers['x-correlation-id'] });
  });

  it('sets security headers', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test -w backend`
Expected: FAIL — modules `./env.js` and `./helpers/app.js` not found.

- [ ] **Step 5: Implement**

`backend/src/config/env.ts`:
```ts
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
```

`backend/src/common/errors/app-error.ts`:
```ts
import type { ErrorCode } from '@pos/shared';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  static unauthenticated(message = 'Authentication required') {
    return new AppError('UNAUTHENTICATED', 401, message);
  }
  static forbidden(message = 'Forbidden') {
    return new AppError('FORBIDDEN', 403, message);
  }
  static notFound(message = 'Not found') {
    return new AppError('NOT_FOUND', 404, message);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError('CONFLICT', 409, message, details);
  }
  static validation(details: unknown) {
    return new AppError('VALIDATION_FAILED', 400, 'Request validation failed', details);
  }
  static rateLimited() {
    return new AppError('RATE_LIMITED', 429, 'Too many attempts, try again later');
  }
}
```

`backend/src/common/request-context.ts`:
```ts
import type { Request } from 'express';

export type HostRealm = 'tenant' | 'platform' | 'unknown';

export interface TenantContext {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  businessTypeId: string;
  planId: string;
}

export interface Principal {
  realm: 'tenant' | 'platform';
  userId: string;
  tenantId?: string;
  sessionId?: string;
  deviceId?: string;
  impersonatorId?: string;
}

export interface RequestWithContext extends Request {
  correlationId: string;
  hostRealm: HostRealm;
  tenant?: TenantContext;
  principal?: Principal;
  device?: { id: string; registerId: string };
  rawBody?: Buffer;
}
```

`backend/src/common/correlation.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { RequestWithContext } from './request-context.js';

const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

export function correlationMiddleware(req: RequestWithContext, res: Response, next: NextFunction) {
  const incoming = req.header('x-correlation-id');
  req.correlationId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
}
```

`backend/src/common/errors/app-error.filter.ts`:
```ts
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ApiErrorBody, ErrorCode } from '@pos/shared';
import type { Response } from 'express';
import type { RequestWithContext } from '../request-context.js';
import { AppError } from './app-error.js';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('AppErrorFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithContext>();
    const res = http.getResponse<Response>();
    const correlationId = req.correlationId ?? 'unknown';

    let status = 500;
    let body: Omit<ApiErrorBody, 'correlationId'> = { code: 'INTERNAL', message: 'Internal error' };

    if (exception instanceof AppError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message };
      if (exception.details !== undefined) body.details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = { code: STATUS_CODES[status] ?? 'INTERNAL', message: status === 404 ? 'Not found' : exception.message };
    } else {
      this.logger.error({ correlationId, err: exception }, 'Unhandled error');
    }

    res.status(status).json({ ...body, correlationId });
  }
}
```

Task 4 adds a branch mapping Prisma unique-constraint errors (`P2002`) to `409 CONFLICT`, once the Prisma client exists.

`backend/src/common/zod.pipe.ts`:
```ts
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from './errors/app-error.js';

export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw AppError.validation(result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    return result.data;
  }
}
```

`backend/src/modules/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok' };
  }
}
```

`backend/src/app.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppErrorFilter } from './common/errors/app-error.filter.js';
import { ConfigModule } from './config/env.js';
import { HealthController } from './modules/health/health.controller.js';

@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AppErrorFilter }],
})
export class AppModule {}
```

`backend/src/configure-app.ts`:
```ts
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
```

`backend/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import { ENV, type Env } from './config/env.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
configureApp(app);
await app.listen(app.get<Env>(ENV).PORT);
```

`backend/test/setup-env.ts`:
```ts
import 'reflect-metadata';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

config({ path: fileURLToPath(new URL('../.env.test', import.meta.url)), override: true });

// Fresh, throwaway keys per test process: nothing secret is committed.
if (!process.env.JWT_PRIVATE_KEY) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  process.env.JWT_PRIVATE_KEY = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64');
  process.env.JWT_PUBLIC_KEY = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }).toString()).toString('base64');
}
process.env.PII_KEY ??= randomBytes(32).toString('base64');
```

`backend/test/global-setup.ts` (Task 3 version; Task 4 adds migrations):
```ts
export default async function globalSetup() {}
```

`backend/test/helpers/app.ts`:
```ts
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -w backend`
Expected: PASS (env.spec: 3, health.e2e.spec: 5).

- [ ] **Step 7: Commit**

```bash
git add backend/ package-lock.json
git commit -m "feat(backend): NestJS scaffold with env validation, error contract, correlation ids"
```

---
### Task 4: Prisma schema, migrations, RLS policies, seed

**Files:**
- Create: `backend/prisma.config.ts`, `backend/prisma/schema.prisma`, `backend/prisma/seed.ts`
- Create (generated, then edited): `backend/prisma/migrations/<ts>_init/migration.sql`, `backend/prisma/migrations/<ts>_rls/migration.sql`
- Modify: `backend/src/common/errors/app-error.filter.ts` (add P2002 → 409)
- Modify: `backend/test/global-setup.ts`
- Create: `backend/test/helpers/db.ts`, `backend/test/helpers/fixtures.ts`
- Test: `backend/test/rls.spec.ts`

**Interfaces:**
- Consumes: `@pos/shared` (`BusinessTypeSchema`), roles from Task 1.
- Produces:
  - Prisma client at `backend/src/generated/prisma/client.js` exporting `PrismaClient`, `Prisma` (incl. `Prisma.TransactionClient`, `Prisma.DbNull`), model types.
  - Tenant-scoped tables (RLS): `Store`, `Register`, `User`, `Role`, `UserRole`, `Device`, `DeviceEnrollment`, `RefreshFamily`, `RefreshToken`, `AuditEvent`.
  - Platform tables (no RLS): `Plan`, `BusinessType`, `Tenant`, `Domain`, `TenantModule`, `SuperAdmin`, `PlatformRefreshFamily`, `PlatformRefreshToken`, `PlatformAuditEvent`.
  - Test helpers: `ownerDb(): PrismaClient`, `appDb(): PrismaClient`, `resetDb(): Promise<void>`, `createPlan(overrides?)`, `createBusinessType({ key?, modules? })`, `createTenant({ slug, status?, modules?, maxDevices?, maxStores?, maxUsers? })`, `createStore(tenantId, { code? })`, `createRegister(tenantId, storeId, { code? })`, `hostFor(slug): string`.

- [ ] **Step 1: Prisma config and schema**

`backend/prisma.config.ts`:
```ts
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Migrations and seeds run as pos_owner. The app itself connects as pos_app (DATABASE_URL).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: { url: env('DATABASE_OWNER_URL') },
});
```

`backend/prisma/schema.prisma`:
```prisma
generator client {
  provider            = "prisma-client"
  output              = "../src/generated/prisma"
  moduleFormat        = "esm"
  importFileExtension = "js"
  runtime             = "nodejs"
}

datasource db {
  provider = "postgresql"
}

enum TenantStatus {
  ACTIVE
  SUSPENDED
}

enum UserStatus {
  ACTIVE
  DISABLED
}

// ─────────────── Platform tables: no tenantId-based RLS ───────────────

model Plan {
  id         String   @id @default(uuid(7)) @db.Uuid
  key        String   @unique
  name       String
  maxStores  Int
  maxDevices Int
  maxUsers   Int
  tenants    Tenant[]
}

model BusinessType {
  id              String   @id @default(uuid(7)) @db.Uuid
  key             String   @unique
  name            String
  description     String?
  modules         String[]
  roleTemplates   Json
  defaultSettings Json     @default("{}")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  tenants         Tenant[]
}

model Tenant {
  id              String         @id @db.Uuid
  name            String
  slug            String         @unique
  status          TenantStatus   @default(ACTIVE)
  businessTypeId  String         @db.Uuid
  planId          String         @db.Uuid
  country         String
  currency        String
  timezone        String
  settings        Json           @default("{}")
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
  deletedAt       DateTime?
  businessType    BusinessType   @relation(fields: [businessTypeId], references: [id])
  plan            Plan           @relation(fields: [planId], references: [id])
  domains         Domain[]
  moduleOverrides TenantModule[]
  stores          Store[]
  users           User[]
  roles           Role[]
}

/// Platform-managed. Has tenantId but is read before any tenant context exists (host resolution).
model Domain {
  id                String    @id @default(uuid(7)) @db.Uuid
  tenantId          String    @db.Uuid
  hostname          String    @unique
  verificationToken String
  verifiedAt        DateTime?
  lastCheckedAt     DateTime?
  createdAt         DateTime  @default(now())
  tenant            Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
}

/// Platform-managed per-tenant module overrides.
model TenantModule {
  tenantId  String   @db.Uuid
  moduleKey String
  enabled   Boolean
  updatedAt DateTime @updatedAt
  tenant    Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@id([tenantId, moduleKey])
}

model SuperAdmin {
  id                  String                  @id @default(uuid(7)) @db.Uuid
  email               String                  @unique
  name                String
  passwordHash        String?
  totpSecretEnc       String?
  totpLastCounter     Int?
  setupTokenHash      String?                 @unique
  setupTokenExpiresAt DateTime?
  failedLoginCount    Int                     @default(0)
  lockedUntil         DateTime?
  createdAt           DateTime                @default(now())
  families            PlatformRefreshFamily[]
}

model PlatformRefreshFamily {
  id                String                 @id @default(uuid(7)) @db.Uuid
  superAdminId      String                 @db.Uuid
  createdAt         DateTime               @default(now())
  absoluteExpiresAt DateTime
  revokedAt         DateTime?
  superAdmin        SuperAdmin             @relation(fields: [superAdminId], references: [id], onDelete: Cascade)
  tokens            PlatformRefreshToken[]
}

model PlatformRefreshToken {
  id        String                @id @default(uuid(7)) @db.Uuid
  familyId  String                @db.Uuid
  tokenHash String                @unique
  expiresAt DateTime
  usedAt    DateTime?
  family    PlatformRefreshFamily @relation(fields: [familyId], references: [id], onDelete: Cascade)
}

model PlatformAuditEvent {
  id            String   @id @db.Uuid
  seq           BigInt   @unique @default(autoincrement())
  actorId       String?  @db.Uuid
  action        String
  entityType    String
  entityId      String?
  before        Json?
  after         Json?
  ip            String?
  userAgent     String?
  correlationId String?
  prevHash      String
  hash          String
  createdAt     DateTime
}

// ─────────────── Tenant-scoped tables: RLS on tenantId ───────────────
// Relations between tenant-scoped tables use composite (tenantId, id) keys so a row can
// never reference another tenant's row: Postgres FK checks do not apply RLS.

model Store {
  id        String     @id @default(uuid(7)) @db.Uuid
  tenantId  String     @db.Uuid
  name      String
  code      String
  createdAt DateTime   @default(now())
  tenant    Tenant     @relation(fields: [tenantId], references: [id])
  registers Register[]

  @@unique([tenantId, id])
  @@unique([tenantId, code])
}

model Register {
  id          String             @id @default(uuid(7)) @db.Uuid
  tenantId    String             @db.Uuid
  storeId     String             @db.Uuid
  name        String
  code        String
  createdAt   DateTime           @default(now())
  store       Store              @relation(fields: [tenantId, storeId], references: [tenantId, id])
  devices     Device[]
  enrollments DeviceEnrollment[]

  @@unique([tenantId, id])
  @@unique([tenantId, code])
}

model User {
  id                  String          @id @default(uuid(7)) @db.Uuid
  tenantId            String          @db.Uuid
  email               String?
  name                String
  passwordHash        String?
  pinHash             String?
  totpSecretEnc       String?
  totpLastCounter     Int?
  setupTokenHash      String?         @unique
  setupTokenExpiresAt DateTime?
  status              UserStatus      @default(ACTIVE)
  failedLoginCount    Int             @default(0)
  lockedUntil         DateTime?
  pinFailedCount      Int             @default(0)
  pinLockedUntil      DateTime?
  createdAt           DateTime        @default(now())
  updatedAt           DateTime        @updatedAt
  tenant              Tenant          @relation(fields: [tenantId], references: [id])
  roles               UserRole[]
  families            RefreshFamily[]

  @@unique([tenantId, id])
  @@unique([tenantId, email])
}

model Role {
  id          String     @id @default(uuid(7)) @db.Uuid
  tenantId    String     @db.Uuid
  name        String
  permissions String[]
  requiresMfa Boolean    @default(false)
  isSystem    Boolean    @default(false)
  createdAt   DateTime   @default(now())
  tenant      Tenant     @relation(fields: [tenantId], references: [id])
  users       UserRole[]

  @@unique([tenantId, id])
  @@unique([tenantId, name])
}

model UserRole {
  tenantId String @db.Uuid
  userId   String @db.Uuid
  roleId   String @db.Uuid
  user     User   @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: Cascade)
  role     Role   @relation(fields: [tenantId, roleId], references: [tenantId, id], onDelete: Cascade)

  @@id([userId, roleId])
}

model Device {
  id           String    @id @default(uuid(7)) @db.Uuid
  tenantId     String    @db.Uuid
  registerId   String    @db.Uuid
  name         String
  publicKeyJwk Json
  enrolledById String    @db.Uuid
  enrolledAt   DateTime  @default(now())
  revokedAt    DateTime?
  register     Register  @relation(fields: [tenantId, registerId], references: [tenantId, id])

  @@unique([tenantId, id])
}

model DeviceEnrollment {
  id          String    @id @default(uuid(7)) @db.Uuid
  tenantId    String    @db.Uuid
  registerId  String    @db.Uuid
  codeHash    String
  createdById String    @db.Uuid
  expiresAt   DateTime
  usedAt      DateTime?
  createdAt   DateTime  @default(now())
  register    Register  @relation(fields: [tenantId, registerId], references: [tenantId, id])

  @@unique([tenantId, codeHash])
}

model RefreshFamily {
  id                String         @id @default(uuid(7)) @db.Uuid
  tenantId          String         @db.Uuid
  userId            String         @db.Uuid
  deviceId          String?        @db.Uuid
  createdAt         DateTime       @default(now())
  absoluteExpiresAt DateTime
  revokedAt         DateTime?
  user              User           @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: Cascade)
  tokens            RefreshToken[]

  @@unique([tenantId, id])
}

model RefreshToken {
  id        String        @id @default(uuid(7)) @db.Uuid
  tenantId  String        @db.Uuid
  familyId  String        @db.Uuid
  tokenHash String        @unique
  expiresAt DateTime
  usedAt    DateTime?
  family    RefreshFamily @relation(fields: [tenantId, familyId], references: [tenantId, id], onDelete: Cascade)
}

model AuditEvent {
  id             String   @id @db.Uuid
  tenantId       String   @db.Uuid
  seq            BigInt   @unique @default(autoincrement())
  actorUserId    String?  @db.Uuid
  impersonatorId String?  @db.Uuid
  deviceId       String?  @db.Uuid
  action         String
  entityType     String
  entityId       String?
  before         Json?
  after          Json?
  ip             String?
  userAgent      String?
  correlationId  String?
  prevHash       String
  hash           String
  createdAt      DateTime

  @@index([tenantId, seq])
}
```

- [ ] **Step 2: Generate the dev env and the init migration**

Run (from repo root):
```bash
npm run env:dev -w backend
cd backend && npx prisma migrate dev --name init && cd ..
```
Expected: `backend/prisma/migrations/<timestamp>_init/migration.sql` created and applied to `pos`; client generated in `backend/src/generated/prisma/`.

- [ ] **Step 3: Create the RLS migration**

Run: `cd backend && npx prisma migrate dev --name rls --create-only && cd ..`
This creates an empty `backend/prisma/migrations/<timestamp>_rls/migration.sql`. Replace its contents with:

```sql
-- Tenant isolation. Every tenant-scoped table is filtered by the transaction-local
-- setting app.tenant_id. With no setting, NULLIF(...) yields NULL and no row matches.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Store', 'Register', 'User', 'Role', 'UserRole', 'Device',
    'DeviceEnrollment', 'RefreshFamily', 'RefreshToken', 'AuditEvent'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- Audit logs are append-only for the application role.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditEvent", "PlatformAuditEvent" FROM pos_app;
```

Run: `cd backend && npx prisma migrate dev && cd ..` → applies `rls`.

Any future migration that adds a table with a `tenantId` column must add it to an RLS block like this one. The test in Step 5 fails the build if one is missed.

- [ ] **Step 4: Seed, test harness, fixtures**

`backend/prisma/seed.ts`:
```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { BusinessTypeSchema } from '@pos/shared';
import { type Prisma, PrismaClient } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_OWNER_URL! }) });

const cashier = { name: 'Cashier', permissions: ['sale.create', 'drawer.open'], requiresMfa: false };
const manager = {
  name: 'Manager',
  permissions: [
    'sale.create', 'sale.void', 'sale.refund', 'price.override', 'discount.apply', 'drawer.open',
    'shift.close', 'stock.adjust', 'report.view', 'device.enroll', 'register.manage',
  ],
  requiresMfa: true,
};

const businessTypes = [
  { key: 'retail', name: 'Retail', modules: ['core', 'customers', 'variants', 'barcodes', 'promotions', 'loyalty'] },
  { key: 'cafe', name: 'Café / Restaurant', modules: ['core', 'customers', 'tables', 'modifiers', 'kitchen-display', 'split-bill'] },
  { key: 'grocery', name: 'Grocery', modules: ['core', 'customers', 'barcodes', 'promotions', 'weighed-items'] },
  { key: 'pharmacy', name: 'Pharmacy', modules: ['core', 'customers', 'barcodes', 'batch-expiry', 'prescriptions'] },
];

await prisma.plan.upsert({
  where: { key: 'standard' },
  update: {},
  create: { key: 'standard', name: 'Standard', maxStores: 3, maxDevices: 10, maxUsers: 25 },
});

for (const raw of businessTypes) {
  const bt = BusinessTypeSchema.parse({ ...raw, roleTemplates: [manager, cashier] });
  await prisma.businessType.upsert({
    where: { key: bt.key },
    update: {},
    create: {
      key: bt.key,
      name: bt.name,
      modules: bt.modules,
      roleTemplates: bt.roleTemplates as Prisma.InputJsonArray,
      defaultSettings: bt.defaultSettings as Prisma.InputJsonObject,
    },
  });
}

await prisma.$disconnect();
console.log('Seeded plan "standard" and business types:', businessTypes.map((b) => b.key).join(', '));
```

Run: `npm run build:shared && npm run db:seed -w backend` → prints the seeded keys.

`backend/test/global-setup.ts` (replace):
```ts
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

export default async function globalSetup() {
  config({ path: fileURLToPath(new URL('../.env.test', import.meta.url)), override: true });
  execSync('npx prisma migrate deploy', {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
    env: process.env,
  });
}
```

`backend/test/helpers/db.ts`:
```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

let owner: PrismaClient | undefined;

/** Connects as pos_owner: bypasses RLS. Only for fixtures and assertions, never app code. */
export function ownerDb(): PrismaClient {
  owner ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_OWNER_URL! }) });
  return owner;
}

/** A fresh client as pos_app (subject to RLS). Caller disconnects. */
export function appDb(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
}

export async function resetDb(): Promise<void> {
  const db = ownerDb();
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length) {
    await db.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
}
```

`backend/test/helpers/fixtures.ts`:
```ts
import { v7 as uuidv7 } from 'uuid';
import { ownerDb } from './db.js';

export const PLATFORM_DOMAIN = 'pos.localhost';
export const ADMIN_HOST = `admin.${PLATFORM_DOMAIN}`;
export const hostFor = (slug: string) => `${slug}.${PLATFORM_DOMAIN}`;

export async function createPlan(overrides: { maxStores?: number; maxDevices?: number; maxUsers?: number } = {}) {
  return ownerDb().plan.create({
    data: { key: `plan-${uuidv7()}`, name: 'Test plan', maxStores: 3, maxDevices: 10, maxUsers: 25, ...overrides },
  });
}

export async function createBusinessType(input: { key?: string; modules?: string[] } = {}) {
  return ownerDb().businessType.create({
    data: {
      key: input.key ?? `bt-${uuidv7().slice(-12)}`,
      name: 'Test type',
      modules: input.modules ?? ['core', 'customers'],
      roleTemplates: [{ name: 'Cashier', permissions: ['sale.create'], requiresMfa: false }],
    },
  });
}

export async function createTenant(input: {
  slug: string;
  status?: 'ACTIVE' | 'SUSPENDED';
  modules?: string[];
  maxStores?: number;
  maxDevices?: number;
  maxUsers?: number;
}) {
  const plan = await createPlan({ maxStores: input.maxStores, maxDevices: input.maxDevices, maxUsers: input.maxUsers });
  const bt = await createBusinessType({ modules: input.modules });
  return ownerDb().tenant.create({
    data: {
      id: uuidv7(),
      name: `Tenant ${input.slug}`,
      slug: input.slug,
      status: input.status ?? 'ACTIVE',
      businessTypeId: bt.id,
      planId: plan.id,
      country: 'LK',
      currency: 'LKR',
      timezone: 'Asia/Colombo',
    },
  });
}

export async function createStore(tenantId: string, input: { code?: string } = {}) {
  return ownerDb().store.create({ data: { tenantId, name: 'Main store', code: input.code ?? `S${uuidv7().slice(-4).toUpperCase()}` } });
}

export async function createRegister(tenantId: string, storeId: string, input: { code?: string } = {}) {
  return ownerDb().register.create({
    data: { tenantId, storeId, name: 'Till 1', code: input.code ?? `R${uuidv7().slice(-4).toUpperCase()}` },
  });
}
```

Note: `createPlan`/`createBusinessType`/`createStore` keep generated keys and codes uppercase-hex-safe so they satisfy the shared schemas when the same values are later posted through the API.

- [ ] **Step 5: Write the failing RLS tests**

`backend/test/rls.spec.ts`:
```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../src/generated/prisma/client.js';
import { appDb, ownerDb, resetDb } from './helpers/db.js';
import { createStore, createTenant } from './helpers/fixtures.js';

/** Platform tables that carry tenantId on purpose and are read before tenant context exists. */
const PLATFORM_TABLES_WITH_TENANT_ID = ['Domain', 'TenantModule'];

const app = appDb();
afterAll(() => app.$disconnect());

function asTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

describe('row-level security', () => {
  beforeEach(resetDb);

  it('every table with a tenantId column has RLS enabled and a tenant_isolation policy', async () => {
    const rows = await ownerDb().$queryRaw<{ table: string; rls: boolean; policy: string | null }[]>`
      SELECT c.relname AS "table", c.relrowsecurity AS rls, p.polname AS policy
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
      LEFT JOIN pg_policy p ON p.polrelid = c.oid AND p.polname = 'tenant_isolation'
      WHERE c.relkind = 'r'`;
    const scoped = rows.filter((r) => !PLATFORM_TABLES_WITH_TENANT_ID.includes(r.table));
    expect(scoped.length).toBeGreaterThanOrEqual(10);
    for (const r of scoped) expect(r).toEqual({ table: r.table, rls: true, policy: 'tenant_isolation' });
  });

  it('the app role cannot bypass RLS and owns no tables', async () => {
    const [role] = await ownerDb().$queryRaw<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'pos_app'`;
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await ownerDb().$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'pos_app'`;
    expect(Number(owned[0].n)).toBe(0);
  });

  it('without tenant context the app role sees no tenant rows', async () => {
    const a = await createTenant({ slug: 'alpha' });
    await createStore(a.id);
    expect(await app.store.findMany()).toEqual([]);
  });

  it('with tenant context only that tenant’s rows are visible', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    const sa = await createStore(a.id);
    await createStore(b.id);
    const seen = await asTenant(a.id, (tx) => tx.store.findMany());
    expect(seen.map((s) => s.id)).toEqual([sa.id]);
  });

  it('WITH CHECK blocks writing a row for another tenant', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    await expect(
      asTenant(a.id, (tx) => tx.store.create({ data: { tenantId: b.id, name: 'Sneaky', code: 'X1' } })),
    ).rejects.toThrow(/row-level security/i);
  });

  it('composite FK blocks a cross-tenant reference', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    const storeB = await createStore(b.id);
    await expect(
      asTenant(a.id, (tx) => tx.register.create({ data: { tenantId: a.id, storeId: storeB.id, name: 'Till', code: 'T1' } })),
    ).rejects.toThrow(/foreign key/i);
  });

  it('cannot read another tenant’s row by id even when the id is known', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    const sb = await createStore(b.id);
    expect(await asTenant(a.id, (tx) => tx.store.findUnique({ where: { id: sb.id } }))).toBeNull();
    // also unaffected by an update attempt
    const updated = await asTenant(a.id, (tx) => tx.store.updateMany({ where: { id: sb.id }, data: { name: 'pwned' } }));
    expect(updated.count).toBe(0);
  });

  it('the app role cannot update or delete audit events', async () => {
    const a = await createTenant({ slug: 'alpha' });
    await expect(asTenant(a.id, (tx) => tx.auditEvent.deleteMany({}))).rejects.toThrow(/permission denied/i);
    await expect(
      asTenant(a.id, (tx) => tx.auditEvent.updateMany({ data: { action: 'x' } })),
    ).rejects.toThrow(/permission denied/i);
  });
});
```

- [ ] **Step 6: Add the unique-violation branch to the error filter**

In `backend/src/common/errors/app-error.filter.ts` add the import and the branch (between the `AppError` and `HttpException` branches):

```ts
import { Prisma } from '../../generated/prisma/client.js';
```
```ts
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
      status = 409;
      body = { code: 'CONFLICT', message: 'Already exists' };
```

- [ ] **Step 7: Run tests**

Run: `npm test -w backend`
Expected: global setup applies both migrations to `pos_test`; `rls.spec.ts` 8 PASS; earlier tests still PASS. If the "composite FK" test fails with a row-level-security error instead of a foreign-key error, the composite relation on `Register.store` is missing — fix the schema, do not loosen the test.

- [ ] **Step 8: Commit**

```bash
git add backend/prisma.config.ts backend/prisma backend/test backend/src/common/errors
git commit -m "feat(db): prisma schema, RLS tenant isolation, composite tenant FKs, seed"
```

---

### Task 5: Infra services — Prisma, TenantDb, Redis, rate limiter, readiness

**Files:**
- Create: `backend/src/infra/prisma.service.ts`, `backend/src/infra/tenant-db.service.ts`, `backend/src/infra/redis.service.ts`, `backend/src/infra/rate-limiter.ts`, `backend/src/infra/infra.module.ts`
- Modify: `backend/src/modules/health/health.controller.ts` (add `/health/ready`), `backend/src/app.module.ts`
- Create: `backend/test/helpers/redis.ts`
- Test: `backend/test/tenant-db.spec.ts`, `backend/test/rate-limiter.spec.ts`, `backend/test/health.e2e.spec.ts` (extend)

**Interfaces:**
- Consumes: `ENV`, `Env`; generated Prisma client.
- Produces:
  - `PrismaService extends PrismaClient` (connects as `pos_app`).
  - `type Tx = Prisma.TransactionClient`.
  - `TenantDb.run<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>`.
  - `RedisService { readonly client: Redis }`.
  - `RateLimiter.consume(key: string, limit: number, windowSec: number): Promise<boolean>`.
  - `InfraModule` (global; exports all four).
  - Test helper `flushRedis(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`backend/test/helpers/redis.ts`:
```ts
import { Redis } from 'ioredis';

export async function flushRedis(): Promise<void> {
  const r = new Redis(process.env.REDIS_URL!);
  await r.flushdb();
  await r.quit();
}
```

`backend/test/tenant-db.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '../src/config/env.js';
import { InfraModule } from '../src/infra/infra.module.js';
import { PrismaService } from '../src/infra/prisma.service.js';
import { TenantDb } from '../src/infra/tenant-db.service.js';
import { resetDb } from './helpers/db.js';
import { createStore, createTenant } from './helpers/fixtures.js';

describe('TenantDb', () => {
  let tenantDb: TenantDb;
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, InfraModule] }).compile();
    await moduleRef.init();
    tenantDb = moduleRef.get(TenantDb);
    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();
  });
  afterAll(() => close());
  beforeEach(resetDb);

  it('scopes reads to the given tenant', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    const sa = await createStore(a.id);
    await createStore(b.id);
    const stores = await tenantDb.run(a.id, (tx) => tx.store.findMany());
    expect(stores.map((s) => s.id)).toEqual([sa.id]);
  });

  it('rejects writes for another tenant', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    await expect(
      tenantDb.run(a.id, (tx) => tx.store.create({ data: { tenantId: b.id, name: 'x', code: 'X1' } })),
    ).rejects.toThrow(/row-level security/i);
  });

  it('context does not leak to the next query on the pool', async () => {
    const a = await createTenant({ slug: 'alpha' });
    await createStore(a.id);
    for (let i = 0; i < 5; i++) await tenantDb.run(a.id, (tx) => tx.store.findMany());
    const results = await Promise.all(Array.from({ length: 10 }, () => prisma.store.findMany()));
    for (const r of results) expect(r).toEqual([]);
    const [setting] = await prisma.$queryRaw<{ v: string | null }[]>`SELECT current_setting('app.tenant_id', true) AS v`;
    expect(setting.v ?? '').toBe('');
  });

  it('rolls back all writes when the callback throws', async () => {
    const a = await createTenant({ slug: 'alpha' });
    await expect(
      tenantDb.run(a.id, async (tx) => {
        await tx.store.create({ data: { tenantId: a.id, name: 'x', code: 'X1' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await tenantDb.run(a.id, (tx) => tx.store.count())).toBe(0);
  });

  it('refuses a tenant id that is not a uuid', async () => {
    await expect(tenantDb.run("x' OR 1=1 --", async () => 1)).rejects.toThrow(/tenant uuid/);
  });
});
```

`backend/test/rate-limiter.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '../src/config/env.js';
import { InfraModule } from '../src/infra/infra.module.js';
import { RateLimiter } from '../src/infra/rate-limiter.js';
import { flushRedis } from './helpers/redis.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, InfraModule] }).compile();
    await moduleRef.init();
    limiter = moduleRef.get(RateLimiter);
    close = () => moduleRef.close();
  });
  afterAll(() => close());
  beforeEach(flushRedis);

  it('allows up to the limit then blocks', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.consume('k1', 3, 60));
    expect(results).toEqual([true, true, true, false]);
  });

  it('keeps keys independent', async () => {
    await limiter.consume('a', 1, 60);
    expect(await limiter.consume('a', 1, 60)).toBe(false);
    expect(await limiter.consume('b', 1, 60)).toBe(true);
  });
});
```

Append to `backend/test/health.e2e.spec.ts` inside the `describe`:
```ts
  it('GET /api/health/ready checks postgres and redis', async () => {
    const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend`
Expected: FAIL — `../src/infra/infra.module.js` not found; ready endpoint 404.

- [ ] **Step 3: Implement**

`backend/src/infra/prisma.service.ts`:
```ts
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ENV, type Env } from '../config/env.js';
import { type Prisma, PrismaClient } from '../generated/prisma/client.js';

export type Tx = Prisma.TransactionClient;

/** Connects as pos_app. Tenant-scoped tables return nothing unless used via TenantDb.run. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

`backend/src/infra/tenant-db.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { PrismaService, type Tx } from './prisma.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantDb {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs fn in a transaction with app.tenant_id set (transaction-local), so RLS scopes every
   * query to this tenant. The setting dies with the transaction; pooled connections stay clean.
   */
  run<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID.test(tenantId)) return Promise.reject(new Error('TenantDb.run requires a tenant uuid'));
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx);
      },
      { timeout: 15_000 },
    );
  }
}
```

`backend/src/infra/redis.service.ts`:
```ts
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { ENV, type Env } from '../config/env.js';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
```

`backend/src/infra/rate-limiter.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service.js';

@Injectable()
export class RateLimiter {
  constructor(private readonly redis: RedisService) {}

  /** Fixed-window counter. Returns false once more than `limit` hits land in the window. */
  async consume(key: string, limit: number, windowSec: number): Promise<boolean> {
    const k = `rl:${key}`;
    const res = await this.redis.client.multi().incr(k).expire(k, windowSec, 'NX').exec();
    const count = Number(res?.[0]?.[1] ?? Number.POSITIVE_INFINITY);
    return count <= limit;
  }
}
```

`backend/src/infra/infra.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { RateLimiter } from './rate-limiter.js';
import { RedisService } from './redis.service.js';
import { TenantDb } from './tenant-db.service.js';

@Global()
@Module({
  providers: [PrismaService, TenantDb, RedisService, RateLimiter],
  exports: [PrismaService, TenantDb, RedisService, RateLimiter],
})
export class InfraModule {}
```

`backend/src/modules/health/health.controller.ts` (replace):
```ts
import { Controller, Get, HttpException } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma.service.js';
import { RedisService } from '../../infra/redis.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      await this.redis.client.ping();
      return { status: 'ok' };
    } catch {
      throw new HttpException('Service unavailable', 503);
    }
  }
}
```

`backend/src/app.module.ts` (replace):
```ts
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppErrorFilter } from './common/errors/app-error.filter.js';
import { ConfigModule } from './config/env.js';
import { InfraModule } from './infra/infra.module.js';
import { HealthController } from './modules/health/health.controller.js';

@Module({
  imports: [ConfigModule, InfraModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AppErrorFilter }],
})
export class AppModule {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/infra backend/src/modules/health backend/src/app.module.ts backend/test
git commit -m "feat(infra): TenantDb with transaction-local tenant context, redis, rate limiter, readiness"
```

---

### Task 6: Crypto primitives, password hashing, JWT service

**Files:**
- Create: `backend/src/common/crypto/hash.ts`, `backend/src/common/crypto/base32.ts`, `backend/src/common/crypto/totp.ts`, `backend/src/common/crypto/aead.ts`, `backend/src/common/crypto/canonical-json.ts`
- Create: `backend/src/security/password.service.ts`, `backend/src/security/token.service.ts`, `backend/src/security/revocation.store.ts`, `backend/src/security/nonce-store.ts`, `backend/src/security/security.module.ts`
- Modify: `backend/src/app.module.ts` (import `SecurityModule`)
- Test: `backend/src/common/crypto/crypto.spec.ts`, `backend/src/security/password.service.spec.ts`, `backend/src/security/token.service.spec.ts`

**Interfaces:**
- Produces:
  - `sha256Hex(data: string | Buffer): string`, `randomToken(bytes?: number): string` (base64url), `randomCode(length?: number): string` (alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`).
  - `base32Encode(buf: Buffer): string`, `base32Decode(s: string): Buffer`.
  - `hotp(key: Buffer, counter: number, digits?: number): string`, `totpCounter(timeMs: number): number`, `totp(key: Buffer, timeMs?: number): string`, `verifyTotp(key: Buffer, code: string, timeMs?: number, lastUsedCounter?: number | null): number | null`, `otpauthUrl(issuer: string, account: string, secret: Buffer): string`.
  - `class Aead { constructor(key: Buffer); encrypt(plain: string): string; decrypt(token: string): string }`.
  - `canonicalJson(value: unknown): string`, `toJsonValue(value: unknown): unknown`.
  - `PasswordService.hash(plain): Promise<string>`, `PasswordService.verify(hashed: string | null | undefined, plain: string): Promise<boolean>` (constant work when `hashed` is missing).
  - `type Audience = 'tenant' | 'platform' | 'mfa' | 'step-up'`; `TokenService.sign(aud: Audience, claims: { sub: string } & Record<string, unknown>, ttlSec: number): Promise<string>`; `TokenService.verify<T>(token: string, aud: Audience): Promise<T & { sub: string; jti: string; exp: number; iat: number }>` (throws `AppError` 401).
  - `interface AccessClaims { sub: string; tid?: string; sid?: string; did?: string; imp?: string }`.
  - `RevocationStore.markRevoked(sessionId: string, ttlSec?: number): Promise<void>`, `RevocationStore.isRevoked(sessionId: string): Promise<boolean>`.
  - `NonceStore.claim(key: string, ttlSec: number): Promise<boolean>` (true the first time only).
  - `SecurityModule` (global; exports `PasswordService`, `TokenService`, `Aead`, `RevocationStore`, `NonceStore`).

- [ ] **Step 1: Write the failing tests**

`backend/src/common/crypto/crypto.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Aead } from './aead.js';
import { base32Decode, base32Encode } from './base32.js';
import { canonicalJson, toJsonValue } from './canonical-json.js';
import { randomCode, sha256Hex } from './hash.js';
import { hotp, otpauthUrl, totp, totpCounter, verifyTotp } from './totp.js';

const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');

describe('hash', () => {
  it('sha256Hex matches a known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('randomCode uses the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) expect(randomCode(8)).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});

describe('base32 (RFC 4648)', () => {
  it.each([
    ['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI'],
  ])('encodes %j as %s and back', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain))).toBe(encoded);
    expect(base32Decode(encoded).toString()).toBe(plain);
  });
  it('rejects invalid characters', () => {
    expect(() => base32Decode('MZ1W')).toThrow();
  });
});

describe('HOTP/TOTP (RFC 4226 / RFC 6238)', () => {
  it.each([[0, '755224'], [1, '287082'], [9, '520489']])('hotp counter %i = %s', (c, code) => {
    expect(hotp(RFC_KEY, c)).toBe(code);
  });
  it.each([
    [59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [2000000000, '69279037'],
  ])('8-digit totp at t=%i = %s', (t, code) => {
    expect(hotp(RFC_KEY, totpCounter(t * 1000), 8)).toBe(code);
  });

  const now = 1_700_000_000_000;
  it('accepts the current and adjacent steps and returns the matched counter', () => {
    const c = totpCounter(now);
    expect(verifyTotp(RFC_KEY, totp(RFC_KEY, now), now)).toBe(c);
    expect(verifyTotp(RFC_KEY, totp(RFC_KEY, now - 30_000), now)).toBe(c - 1);
    expect(verifyTotp(RFC_KEY, totp(RFC_KEY, now + 30_000), now)).toBe(c + 1);
  });
  it('rejects codes two steps away', () => {
    expect(verifyTotp(RFC_KEY, totp(RFC_KEY, now - 60_000), now)).toBeNull();
  });
  it('rejects a replayed counter', () => {
    const code = totp(RFC_KEY, now);
    const used = verifyTotp(RFC_KEY, code, now)!;
    expect(verifyTotp(RFC_KEY, code, now, used)).toBeNull();
  });
  it('rejects malformed codes', () => {
    expect(verifyTotp(RFC_KEY, '12345a', now)).toBeNull();
    expect(verifyTotp(RFC_KEY, '1234567', now)).toBeNull();
  });
  it('builds an otpauth url', () => {
    expect(otpauthUrl('POS', 'a@b.lk', Buffer.from('foobar'))).toBe(
      'otpauth://totp/POS%3Aa%40b.lk?secret=MZXW6YTBOI&issuer=POS&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('Aead', () => {
  const aead = new Aead(randomBytes(32));
  it('round-trips', () => {
    expect(aead.decrypt(aead.encrypt('secret value'))).toBe('secret value');
  });
  it('produces different ciphertexts for the same plaintext', () => {
    expect(aead.encrypt('x')).not.toBe(aead.encrypt('x'));
  });
  it('detects tampering', () => {
    const [v, iv, ct, tag] = aead.encrypt('secret value').split('.');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 1;
    expect(() => aead.decrypt([v, iv, flipped.toString('base64url'), tag].join('.'))).toThrow();
  });
  it('fails with a different key', () => {
    expect(() => new Aead(randomBytes(32)).decrypt(aead.encrypt('x'))).toThrow();
  });
  it('requires a 32-byte key', () => {
    expect(() => new Aead(randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe('canonicalJson', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      canonicalJson({ a: { d: [3, { x: 2, y: 1 }] }, b: 1 }),
    );
  });
  it('toJsonValue serialises dates to ISO strings', () => {
    expect(toJsonValue({ at: new Date('2026-01-01T00:00:00Z') })).toEqual({ at: '2026-01-01T00:00:00.000Z' });
    expect(toJsonValue(undefined)).toBeNull();
  });
});
```

`backend/src/security/password.service.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  const svc = new PasswordService();
  it('hashes with argon2id and verifies', async () => {
    const h = await svc.hash('correct horse battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await svc.verify(h, 'correct horse battery')).toBe(true);
    expect(await svc.verify(h, 'wrong')).toBe(false);
  });
  it('returns false (not throws) for a missing or malformed hash', async () => {
    expect(await svc.verify(null, 'x')).toBe(false);
    expect(await svc.verify('not-a-hash', 'x')).toBe(false);
  });
});
```

`backend/src/security/token.service.spec.ts`:
```ts
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import { TokenService } from './token.service.js';

describe('TokenService', () => {
  const svc = new TokenService(loadEnv());
  beforeAll(() => svc.onModuleInit());
  afterEach(() => vi.useRealTimers());

  it('signs and verifies with the right audience', async () => {
    const token = await svc.sign('tenant', { sub: 'u1', tid: 't1' }, 300);
    const claims = await svc.verify<{ tid: string }>(token, 'tenant');
    expect(claims).toMatchObject({ sub: 'u1', tid: 't1', iss: 'pos', aud: 'tenant' });
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects the wrong audience', async () => {
    const token = await svc.sign('tenant', { sub: 'u1' }, 300);
    await expect(svc.verify(token, 'platform')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects expired tokens', async () => {
    const token = await svc.sign('tenant', { sub: 'u1' }, 300);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 301_000);
    await expect(svc.verify(token, 'tenant')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects tokens signed by another key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const other = new TokenService(
      loadEnv({
        ...process.env,
        JWT_PRIVATE_KEY: b64(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
        JWT_PUBLIC_KEY: b64(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
      }),
    );
    await other.onModuleInit();
    const forged = await other.sign('tenant', { sub: 'u1' }, 300);
    await expect(svc.verify(forged, 'tenant')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects unsigned (alg: none) tokens', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: 'none' })}.${enc({ sub: 'u1', aud: 'tenant', iss: 'pos', exp: now + 60 })}.`;
    await expect(svc.verify(unsigned, 'tenant')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- src/common src/security`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`backend/src/common/crypto/hash.ts`:
```ts
import { createHash, randomBytes, randomInt } from 'node:crypto';

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-typeable code without 0/O/1/I ambiguity. */
export function randomCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}
```

`backend/src/common/crypto/base32.ts`:
```ts
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
```

`backend/src/common/crypto/totp.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './base32.js';

export const TOTP_STEP_SECONDS = 30;

export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export const totpCounter = (timeMs: number): number => Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);

export const totp = (key: Buffer, timeMs = Date.now()): string => hotp(key, totpCounter(timeMs));

/**
 * Returns the counter that matched (store it to block replay), or null.
 * Accepts one step of clock drift either way; never accepts a counter <= lastUsedCounter.
 */
export function verifyTotp(key: Buffer, code: string, timeMs = Date.now(), lastUsedCounter: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpCounter(timeMs);
  for (const counter of [now - 1, now, now + 1]) {
    if (lastUsedCounter !== null && counter <= lastUsedCounter) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, counter)), Buffer.from(code))) return counter;
  }
  return null;
}

export function otpauthUrl(issuer: string, account: string, secret: Buffer): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
```

`backend/src/common/crypto/aead.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM. Output: v1.<iv>.<ciphertext>.<tag>, all base64url. */
export class Aead {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Aead key must be 32 bytes');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  decrypt(token: string): string {
    const [version, iv, ct, tag] = token.split('.');
    if (version !== 'v1' || !iv || !ct || !tag) throw new Error('Malformed ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }
}
```

`backend/src/common/crypto/canonical-json.ts`:
```ts
/** Deterministic JSON: object keys sorted, undefined members dropped. Input must be JSON-like. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Normalises to plain JSON (Dates → ISO strings) so stored and hashed values agree. */
export function toJsonValue(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}
```

`backend/src/security/password.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// OWASP argon2id baseline (19 MiB, t=2, p=1). argon2id is the library default algorithm.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

@Injectable()
export class PasswordService {
  private readonly dummyHash = hash('timing-equaliser', OPTIONS);

  hash(plain: string): Promise<string> {
    return hash(plain, OPTIONS);
  }

  /** Always does one argon2 verification, so unknown users cost the same as wrong passwords. */
  async verify(hashed: string | null | undefined, plain: string): Promise<boolean> {
    try {
      if (!hashed) {
        await verify(await this.dummyHash, plain);
        return false;
      }
      return await verify(hashed, plain);
    } catch {
      return false;
    }
  }
}
```

`backend/src/security/token.service.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import { AppError } from '../common/errors/app-error.js';
import { ENV, type Env } from '../config/env.js';

export type Audience = 'tenant' | 'platform' | 'mfa' | 'step-up';

export interface AccessClaims {
  sub: string;
  tid?: string;
  sid?: string;
  did?: string;
  imp?: string;
}

type StandardClaims = { sub: string; jti: string; exp: number; iat: number; iss: string; aud: string };
type Key = Awaited<ReturnType<typeof importPKCS8>>;

const ISSUER = 'pos';
const fromB64 = (v: string) => Buffer.from(v, 'base64').toString('utf8');

@Injectable()
export class TokenService implements OnModuleInit {
  private privateKey!: Key;
  private publicKey!: Key;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async onModuleInit() {
    this.privateKey = await importPKCS8(fromB64(this.env.JWT_PRIVATE_KEY), 'EdDSA');
    this.publicKey = await importSPKI(fromB64(this.env.JWT_PUBLIC_KEY), 'EdDSA');
  }

  sign(aud: Audience, claims: { sub: string } & Record<string, unknown>, ttlSec: number): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer(ISSUER)
      .setAudience(aud)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSec)
      .setJti(randomUUID())
      .sign(this.privateKey);
  }

  async verify<T = Record<string, unknown>>(token: string, aud: Audience): Promise<T & StandardClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, { issuer: ISSUER, audience: aud, algorithms: ['EdDSA'] });
      if (typeof payload.sub !== 'string') throw new Error('missing sub');
      return payload as unknown as T & StandardClaims;
    } catch {
      throw AppError.unauthenticated('Invalid or expired token');
    }
  }
}
```

`backend/src/security/revocation.store.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { RedisService } from '../infra/redis.service.js';

/** Revoked session ids, kept at least as long as any access token for them can live. */
@Injectable()
export class RevocationStore {
  constructor(private readonly redis: RedisService) {}

  async markRevoked(sessionId: string, ttlSec = 300): Promise<void> {
    await this.redis.client.set(`revoked:${sessionId}`, '1', 'EX', ttlSec);
  }

  async isRevoked(sessionId: string): Promise<boolean> {
    return (await this.redis.client.exists(`revoked:${sessionId}`)) === 1;
  }
}
```

`backend/src/security/nonce-store.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { RedisService } from '../infra/redis.service.js';

@Injectable()
export class NonceStore {
  constructor(private readonly redis: RedisService) {}

  /** True only for the first claim of a key within ttlSec. */
  async claim(key: string, ttlSec: number): Promise<boolean> {
    return (await this.redis.client.set(`nonce:${key}`, '1', 'EX', ttlSec, 'NX')) === 'OK';
  }
}
```

`backend/src/security/security.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { Aead } from '../common/crypto/aead.js';
import { ENV, type Env } from '../config/env.js';
import { NonceStore } from './nonce-store.js';
import { PasswordService } from './password.service.js';
import { RevocationStore } from './revocation.store.js';
import { TokenService } from './token.service.js';

@Global()
@Module({
  providers: [
    PasswordService,
    TokenService,
    RevocationStore,
    NonceStore,
    { provide: Aead, inject: [ENV], useFactory: (env: Env) => new Aead(Buffer.from(env.PII_KEY, 'base64')) },
  ],
  exports: [PasswordService, TokenService, RevocationStore, NonceStore, Aead],
})
export class SecurityModule {}
```

In `backend/src/app.module.ts`, add `SecurityModule` to `imports` (after `InfraModule`) with its import line:
```ts
import { SecurityModule } from './security/security.module.js';
// imports: [ConfigModule, InfraModule, SecurityModule],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/common/crypto backend/src/security backend/src/app.module.ts
git commit -m "feat(security): argon2id, EdDSA JWT, AES-GCM, RFC 6238 TOTP with replay guard"
```

---

### Task 7: Hash-chained audit log

**Files:**
- Create: `backend/src/modules/audit/audit.service.ts`, `backend/src/modules/audit/audit-context.ts`, `backend/src/modules/audit/audit.module.ts`
- Modify: `backend/src/app.module.ts` (import `AuditModule`)
- Test: `backend/test/audit.spec.ts`

**Interfaces:**
- Consumes: `Tx`, `TenantDb`, `canonicalJson`, `toJsonValue`, `sha256Hex`, `Prisma.DbNull`.
- Produces:
  - `interface AuditEntry { action: string; entityType: string; entityId?: string | null; actorUserId?: string | null; impersonatorId?: string | null; deviceId?: string | null; before?: unknown; after?: unknown; ip?: string | null; userAgent?: string | null; correlationId?: string | null }`
  - `interface PlatformAuditEntry { action; entityType; entityId?; actorId?: string | null; before?; after?; ip?; userAgent?; correlationId? }`
  - `type ChainResult = { ok: true; count: number } | { ok: false; brokenAtId: string }`
  - `AuditService.record(tx: Tx, tenantId: string, entry: AuditEntry): Promise<void>` — must be called inside `TenantDb.run` for that tenant.
  - `AuditService.recordPlatform(tx: Tx, entry: PlatformAuditEntry): Promise<void>`
  - `AuditService.verifyTenantChain(tx: Tx, tenantId: string): Promise<ChainResult>`, `AuditService.verifyPlatformChain(tx: Tx): Promise<ChainResult>`
  - `GENESIS_HASH` (64 zeros)
  - `auditContext(req: RequestWithContext): Pick<AuditEntry, 'actorUserId' | 'impersonatorId' | 'deviceId' | 'ip' | 'userAgent' | 'correlationId'>` and `requestMeta(req): { ip: string | null; userAgent: string | null; correlationId: string }`

- [ ] **Step 1: Write the failing tests**

`backend/test/audit.spec.ts`:
```ts
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '../src/config/env.js';
import { InfraModule } from '../src/infra/infra.module.js';
import { PrismaService } from '../src/infra/prisma.service.js';
import { TenantDb } from '../src/infra/tenant-db.service.js';
import { AuditModule } from '../src/modules/audit/audit.module.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { createTenant } from './helpers/fixtures.js';

describe('AuditService', () => {
  let audit: AuditService;
  let tenantDb: TenantDb;
  let prisma: PrismaService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [ConfigModule, InfraModule, AuditModule] }).compile();
    await m.init();
    audit = m.get(AuditService);
    tenantDb = m.get(TenantDb);
    prisma = m.get(PrismaService);
    close = () => m.close();
  });
  afterAll(() => close());
  beforeEach(resetDb);

  const write = (tenantId: string, i: number) =>
    tenantDb.run(tenantId, (tx) =>
      audit.record(tx, tenantId, { action: 'test.event', entityType: 'Test', entityId: String(i), after: { i, at: new Date(0) } }),
    );

  it('chains events and verifies', async () => {
    const t = await createTenant({ slug: 'alpha' });
    for (let i = 0; i < 3; i++) await write(t.id, i);
    const rows = await ownerDb().auditEvent.findMany({ orderBy: { seq: 'asc' } });
    expect(rows[0].prevHash).toBe('0'.repeat(64));
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(await tenantDb.run(t.id, (tx) => audit.verifyTenantChain(tx, t.id))).toEqual({ ok: true, count: 3 });
  });

  it('keeps one chain per tenant', async () => {
    const a = await createTenant({ slug: 'alpha' });
    const b = await createTenant({ slug: 'bravo' });
    await write(a.id, 1);
    await write(b.id, 1);
    const rows = await ownerDb().auditEvent.findMany();
    expect(rows.every((r) => r.prevHash === '0'.repeat(64))).toBe(true);
  });

  it('detects a modified event', async () => {
    const t = await createTenant({ slug: 'alpha' });
    for (let i = 0; i < 3; i++) await write(t.id, i);
    const rows = await ownerDb().auditEvent.findMany({ orderBy: { seq: 'asc' } });
    await ownerDb().auditEvent.update({ where: { id: rows[1].id }, data: { after: { i: 999 } } });
    expect(await tenantDb.run(t.id, (tx) => audit.verifyTenantChain(tx, t.id))).toEqual({ ok: false, brokenAtId: rows[1].id });
  });

  it('detects a deleted event', async () => {
    const t = await createTenant({ slug: 'alpha' });
    for (let i = 0; i < 3; i++) await write(t.id, i);
    const rows = await ownerDb().auditEvent.findMany({ orderBy: { seq: 'asc' } });
    await ownerDb().auditEvent.delete({ where: { id: rows[1].id } });
    expect(await tenantDb.run(t.id, (tx) => audit.verifyTenantChain(tx, t.id))).toEqual({ ok: false, brokenAtId: rows[2].id });
  });

  it('concurrent writes keep a linear chain', async () => {
    const t = await createTenant({ slug: 'alpha' });
    await Promise.all(Array.from({ length: 10 }, (_, i) => write(t.id, i)));
    const result = await tenantDb.run(t.id, (tx) => audit.verifyTenantChain(tx, t.id));
    expect(result).toEqual({ ok: true, count: 10 });
  });

  it('chains platform events', async () => {
    for (let i = 0; i < 3; i++) {
      await prisma.$transaction((tx) => audit.recordPlatform(tx, { action: 'p.test', entityType: 'Test', entityId: String(i) }));
    }
    expect(await prisma.$transaction((tx) => audit.verifyPlatformChain(tx))).toEqual({ ok: true, count: 3 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/audit.spec.ts`
Expected: FAIL — `audit.module.js` not found.

- [ ] **Step 3: Implement**

`backend/src/modules/audit/audit.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { canonicalJson, toJsonValue } from '../../common/crypto/canonical-json.js';
import { sha256Hex } from '../../common/crypto/hash.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../infra/prisma.service.js';

export const GENESIS_HASH = '0'.repeat(64);
const PLATFORM_LOCK_KEY = 7_340_001;

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  impersonatorId?: string | null;
  deviceId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface PlatformAuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export type ChainResult = { ok: true; count: number } | { ok: false; brokenAtId: string };

type Hashable = Record<string, unknown> & { id: string; createdAt: Date };

/** The hash covers every stored field except seq, prevHash and hash themselves. */
function hashOf(prevHash: string, row: Hashable): string {
  const { createdAt, ...rest } = row;
  return sha256Hex(prevHash + canonicalJson({ ...rest, createdAt: createdAt.toISOString() }));
}

const jsonOrDbNull = (v: unknown) => (v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));

function verifyRows<R extends Hashable & { prevHash: string; hash: string }>(rows: R[], strip: (r: R) => Hashable): ChainResult {
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prevHash !== prev || r.hash !== hashOf(prev, strip(r))) return { ok: false, brokenAtId: r.id };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}

@Injectable()
export class AuditService {
  async record(tx: Tx, tenantId: string, e: AuditEntry): Promise<void> {
    // Serialise writers per tenant so the chain stays linear under concurrency.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text))`;
    const last = await tx.auditEvent.findFirst({ where: { tenantId }, orderBy: { seq: 'desc' }, select: { hash: true } });
    const prevHash = last?.hash ?? GENESIS_HASH;
    const row = {
      id: uuidv7(),
      tenantId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      actorUserId: e.actorUserId ?? null,
      impersonatorId: e.impersonatorId ?? null,
      deviceId: e.deviceId ?? null,
      before: toJsonValue(e.before),
      after: toJsonValue(e.after),
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      correlationId: e.correlationId ?? null,
      createdAt: new Date(),
    };
    await tx.auditEvent.create({
      data: { ...row, before: jsonOrDbNull(row.before), after: jsonOrDbNull(row.after), prevHash, hash: hashOf(prevHash, row) },
    });
  }

  async recordPlatform(tx: Tx, e: PlatformAuditEntry): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_LOCK_KEY}::bigint)`;
    const last = await tx.platformAuditEvent.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
    const prevHash = last?.hash ?? GENESIS_HASH;
    const row = {
      id: uuidv7(),
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      actorId: e.actorId ?? null,
      before: toJsonValue(e.before),
      after: toJsonValue(e.after),
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
      correlationId: e.correlationId ?? null,
      createdAt: new Date(),
    };
    await tx.platformAuditEvent.create({
      data: { ...row, before: jsonOrDbNull(row.before), after: jsonOrDbNull(row.after), prevHash, hash: hashOf(prevHash, row) },
    });
  }

  async verifyTenantChain(tx: Tx, tenantId: string): Promise<ChainResult> {
    const rows = await tx.auditEvent.findMany({ where: { tenantId }, orderBy: { seq: 'asc' } });
    return verifyRows(rows, ({ seq: _s, prevHash: _p, hash: _h, ...rest }) => rest);
  }

  async verifyPlatformChain(tx: Tx): Promise<ChainResult> {
    const rows = await tx.platformAuditEvent.findMany({ orderBy: { seq: 'asc' } });
    return verifyRows(rows, ({ seq: _s, prevHash: _p, hash: _h, ...rest }) => rest);
  }
}
```

`backend/src/modules/audit/audit-context.ts`:
```ts
import type { RequestWithContext } from '../../common/request-context.js';
import type { AuditEntry } from './audit.service.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  correlationId: string;
}

export function requestMeta(req: RequestWithContext): RequestMeta {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null, correlationId: req.correlationId };
}

/** Who did it, from where: spread into every audit entry written on behalf of a request. */
export function auditContext(
  req: RequestWithContext,
): Pick<AuditEntry, 'actorUserId' | 'impersonatorId' | 'deviceId' | 'ip' | 'userAgent' | 'correlationId'> {
  return {
    actorUserId: req.principal?.realm === 'tenant' ? req.principal.userId : null,
    impersonatorId: req.principal?.impersonatorId ?? null,
    deviceId: req.device?.id ?? req.principal?.deviceId ?? null,
    ...requestMeta(req),
  };
}
```

`backend/src/modules/audit/audit.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
```

Add `AuditModule` to `AppModule.imports` (after `SecurityModule`) with `import { AuditModule } from './modules/audit/audit.module.js';`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/audit backend/src/app.module.ts backend/test/audit.spec.ts
git commit -m "feat(audit): append-only hash-chained tenant and platform audit logs"
```

---

### Task 8: Host-based tenant resolution, route decorators, realm check

**Files:**
- Create: `backend/src/modules/access/decorators.ts`, `backend/src/modules/access/tenant-resolver.service.ts`, `backend/src/modules/access/checks/realm.check.ts`, `backend/src/modules/access/access.guard.ts`, `backend/src/modules/access/access.module.ts`
- Modify: `backend/src/configure-app.ts`, `backend/src/app.module.ts`, `backend/src/modules/health/health.controller.ts`
- Create: `backend/test/helpers/probe.controller.ts`
- Test: `backend/test/tenant-resolution.e2e.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `RedisService`, `ENV`, `RequestWithContext`, `TenantContext`.
- Produces:
  - Decorators: `Realm(realm: 'tenant' | 'platform' | 'any')` (default when absent: `'tenant'`), `Public()`, `RequiresDevice()`, `RequiresModule(key: ModuleKey)`, `RequiresPermission(p: Permission)`, `RequiresStepUp(action: Permission)`; metadata keys `REALM_KEY`, `PUBLIC_KEY`, `DEVICE_KEY`, `MODULE_KEY`, `PERMISSION_KEY`, `STEP_UP_KEY`; helper `routeMeta<T>(reflector, key, ctx): T | undefined`, `routeRealm(reflector, ctx): RouteRealm`.
  - `TenantResolverService.resolveHost(host: string | undefined): Promise<{ realm: HostRealm; tenant?: TenantContext }>`, `.invalidateHosts(hosts: string[]): Promise<void>`, `.invalidateTenant(tenantId: string): Promise<void>`, `.middleware` (Express middleware, bound).
  - `interface AccessCheck { check(ctx: ExecutionContext, req: RequestWithContext): Promise<void> | void }`, `RealmCheck`, `AccessGuard` (registered as `APP_GUARD` by `AccessModule`).
  - `AccessModule` (exports `TenantResolverService`).
  - `ProbeController` (test only) with routes under `/api/probe/*`, used by later tasks.

- [ ] **Step 1: Write the probe controller and failing tests**

`backend/test/helpers/probe.controller.ts` (all routes later tasks need; checks are added task by task):
```ts
import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { RequestWithContext } from '../../src/common/request-context.js';
import {
  Public, Realm, RequiresDevice, RequiresModule, RequiresPermission, RequiresStepUp,
} from '../../src/modules/access/decorators.js';

@Controller('probe')
export class ProbeController {
  @Public() @Get('tenant')
  tenant(@Req() req: RequestWithContext) {
    return { realm: req.hostRealm, tenantId: req.tenant?.id ?? null };
  }

  @Public() @Realm('platform') @Get('platform')
  platform() {
    return { ok: true };
  }

  @Public() @Realm('any') @Get('any')
  any(@Req() req: RequestWithContext) {
    return { realm: req.hostRealm };
  }

  @Get('authed')
  authed(@Req() req: RequestWithContext) {
    return req.principal;
  }

  @Realm('platform') @Get('platform-authed')
  platformAuthed(@Req() req: RequestWithContext) {
    return req.principal;
  }

  @RequiresModule('tables') @Get('tables')
  tables() {
    return { ok: true };
  }

  @RequiresPermission('sale.refund') @Get('refund-permission')
  refundPermission() {
    return { ok: true };
  }

  @RequiresDevice() @RequiresPermission('sale.create') @Post('device-sale') @HttpCode(200)
  deviceSale(@Req() req: RequestWithContext) {
    return { device: req.device, principal: req.principal };
  }

  @RequiresDevice() @RequiresStepUp('sale.refund') @Post('refund') @HttpCode(200)
  refund() {
    return { refunded: true };
  }
}
```

`backend/test/tenant-resolution.e2e.spec.ts`:
```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENV, loadEnv } from '../src/config/env.js';
import { TenantResolverService } from '../src/modules/access/tenant-resolver.service.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createTenant, hostFor } from './helpers/fixtures.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

describe('tenant resolution and realms', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
  });

  it('resolves {slug}.platform-domain to the tenant', async () => {
    const t = await createTenant({ slug: 'acme' });
    const res = await http().get('/api/probe/tenant').set('Host', hostFor('acme')).expect(200);
    expect(res.body).toEqual({ realm: 'tenant', tenantId: t.id });
  });

  it('ignores the port in the Host header', async () => {
    const t = await createTenant({ slug: 'acme' });
    const res = await http().get('/api/probe/tenant').set('Host', `${hostFor('acme')}:8443`).expect(200);
    expect(res.body.tenantId).toBe(t.id);
  });

  it.each(['nobody.pos.localhost', 'x.acme.pos.localhost', 'pos.localhost', 'evil.com'])('returns 404 for unknown host %s', async (host) => {
    await createTenant({ slug: 'acme' });
    const res = await http().get('/api/probe/tenant').set('Host', host).expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('resolves a verified custom domain but not an unverified one', async () => {
    const t = await createTenant({ slug: 'acme' });
    await ownerDb().domain.create({ data: { tenantId: t.id, hostname: 'shop.acme.lk', verificationToken: 'x', verifiedAt: new Date() } });
    await ownerDb().domain.create({ data: { tenantId: t.id, hostname: 'pending.acme.lk', verificationToken: 'y' } });
    expect((await http().get('/api/probe/tenant').set('Host', 'shop.acme.lk').expect(200)).body.tenantId).toBe(t.id);
    await http().get('/api/probe/tenant').set('Host', 'pending.acme.lk').expect(404);
  });

  it('does not resolve soft-deleted tenants', async () => {
    const t = await createTenant({ slug: 'acme' });
    await ownerDb().tenant.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
    await http().get('/api/probe/tenant').set('Host', hostFor('acme')).expect(404);
  });

  it('serves platform routes only on the admin host', async () => {
    await createTenant({ slug: 'acme' });
    await http().get('/api/probe/platform').set('Host', ADMIN_HOST).expect(200);
    await http().get('/api/probe/platform').set('Host', hostFor('acme')).expect(404);
    await http().get('/api/probe/tenant').set('Host', ADMIN_HOST).expect(404);
  });

  it('serves realm-any routes on any host', async () => {
    const res = await http().get('/api/probe/any').set('Host', 'localhost').expect(200);
    expect(res.body).toEqual({ realm: 'unknown' });
    await http().get('/api/health').set('Host', 'localhost').expect(200);
  });

  it('invalidateTenant drops cached resolution', async () => {
    const t = await createTenant({ slug: 'acme' });
    const resolver = app.get(TenantResolverService);
    expect((await resolver.resolveHost(hostFor('acme'))).tenant?.status).toBe('ACTIVE');
    await ownerDb().tenant.update({ where: { id: t.id }, data: { status: 'SUSPENDED' } });
    expect((await resolver.resolveHost(hostFor('acme'))).tenant?.status).toBe('ACTIVE'); // cached
    await resolver.invalidateTenant(t.id);
    expect((await resolver.resolveHost(hostFor('acme'))).tenant?.status).toBe('SUSPENDED');
  });
});

describe('platform IP allowlist', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp({
      controllers: [ProbeController],
      customize: (b) => b.overrideProvider(ENV).useValue({ ...loadEnv(), PLATFORM_IP_ALLOWLIST: ['10.9.9.9'] }),
    });
  });
  afterAll(() => app.close());
  afterEach(flushRedis);

  it('hides platform routes from IPs outside the allowlist', async () => {
    await request(app.getHttpServer()).get('/api/probe/platform').set('Host', ADMIN_HOST).expect(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/tenant-resolution.e2e.spec.ts`
Expected: FAIL — `decorators.js` not found.

- [ ] **Step 3: Implement**

`backend/src/modules/access/decorators.ts`:
```ts
import { type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ModuleKey, Permission } from '@pos/shared';

export type RouteRealm = 'tenant' | 'platform' | 'any';

export const REALM_KEY = 'pos:realm';
export const PUBLIC_KEY = 'pos:public';
export const DEVICE_KEY = 'pos:device';
export const MODULE_KEY = 'pos:module';
export const PERMISSION_KEY = 'pos:permission';
export const STEP_UP_KEY = 'pos:step-up';

/** Which host serves this route. Default (no decorator) is 'tenant'. */
export const Realm = (realm: RouteRealm) => SetMetadata(REALM_KEY, realm);
/** Skips user authentication. Realm, tenant status and device checks still apply. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const RequiresDevice = () => SetMetadata(DEVICE_KEY, true);
export const RequiresModule = (key: ModuleKey) => SetMetadata(MODULE_KEY, key);
export const RequiresPermission = (permission: Permission) => SetMetadata(PERMISSION_KEY, permission);
export const RequiresStepUp = (action: Permission) => SetMetadata(STEP_UP_KEY, action);

export function routeMeta<T>(reflector: Reflector, key: string, ctx: ExecutionContext): T | undefined {
  return reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);
}

export function routeRealm(reflector: Reflector, ctx: ExecutionContext): RouteRealm {
  return routeMeta<RouteRealm>(reflector, REALM_KEY, ctx) ?? 'tenant';
}
```

`backend/src/modules/access/tenant-resolver.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { HostRealm, RequestWithContext, TenantContext } from '../../common/request-context.js';
import { ENV, type Env } from '../../config/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { RedisService } from '../../infra/redis.service.js';

const CACHE_TTL_SEC = 60;
type Resolution = { realm: HostRealm; tenant?: TenantContext };

@Injectable()
export class TenantResolverService {
  private readonly base: string;

  constructor(
    @Inject(ENV) env: Env,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.base = env.PLATFORM_DOMAIN;
  }

  normaliseHost(raw: string | undefined): string {
    return (raw ?? '').trim().toLowerCase().replace(/:\d+$/, '');
  }

  async resolveHost(raw: string | undefined): Promise<Resolution> {
    const host = this.normaliseHost(raw);
    if (!host) return { realm: 'unknown' };
    if (host === `admin.${this.base}`) return { realm: 'platform' };

    const cached = await this.redis.client.get(`host:${host}`);
    if (cached) return cached === 'none' ? { realm: 'unknown' } : { realm: 'tenant', tenant: JSON.parse(cached) as TenantContext };

    const tenant = await this.lookup(host);
    await this.redis.client.set(`host:${host}`, tenant ? JSON.stringify(tenant) : 'none', 'EX', CACHE_TTL_SEC);
    return tenant ? { realm: 'tenant', tenant } : { realm: 'unknown' };
  }

  private async lookup(host: string): Promise<TenantContext | null> {
    const select = { id: true, name: true, slug: true, status: true, businessTypeId: true, planId: true, deletedAt: true } as const;
    let row: (TenantContext & { deletedAt: Date | null }) | null = null;
    if (host.endsWith(`.${this.base}`)) {
      const slug = host.slice(0, -(this.base.length + 1));
      if (slug && !slug.includes('.')) row = await this.prisma.tenant.findUnique({ where: { slug }, select });
    } else {
      const domain = await this.prisma.domain.findUnique({ where: { hostname: host }, select: { verifiedAt: true, tenant: { select } } });
      if (domain?.verifiedAt) row = domain.tenant;
    }
    if (!row || row.deletedAt) return null;
    const { deletedAt: _deleted, ...tenant } = row;
    return tenant;
  }

  async invalidateHosts(hosts: string[]): Promise<void> {
    if (hosts.length) await this.redis.client.del(...hosts.map((h) => `host:${this.normaliseHost(h)}`));
  }

  async invalidateTenant(tenantId: string): Promise<void> {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, domains: { select: { hostname: true } } } });
    if (t) await this.invalidateHosts([`${t.slug}.${this.base}`, ...t.domains.map((d) => d.hostname)]);
  }

  readonly middleware = async (req: RequestWithContext, res: Response, next: NextFunction) => {
    try {
      const r = await this.resolveHost(req.headers.host);
      req.hostRealm = r.realm;
      req.tenant = r.tenant;
      next();
    } catch {
      res.status(503).json({ code: 'INTERNAL', message: 'Service unavailable', correlationId: req.correlationId });
    }
  };
}
```

`backend/src/modules/access/checks/realm.check.ts`:
```ts
import { type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import { ENV, type Env } from '../../../config/env.js';
import type { AccessCheck } from '../access.guard.js';
import { routeRealm } from '../decorators.js';

const normaliseIp = (ip: string | undefined) => (ip ?? '').replace(/^::ffff:/, '');

/** Routes exist only on their own host. Mismatches look like 404, not 403, to avoid probing. */
@Injectable()
export class RealmCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  check(ctx: ExecutionContext, req: RequestWithContext) {
    const realm = routeRealm(this.reflector, ctx);
    if (realm === 'any') return;
    if (realm !== req.hostRealm) throw AppError.notFound();
    const allow = this.env.PLATFORM_IP_ALLOWLIST;
    if (realm === 'platform' && allow.length && !allow.includes(normaliseIp(req.ip))) throw AppError.notFound();
  }
}
```

`backend/src/modules/access/access.guard.ts`:
```ts
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { RequestWithContext } from '../../common/request-context.js';
import { RealmCheck } from './checks/realm.check.js';

export interface AccessCheck {
  check(ctx: ExecutionContext, req: RequestWithContext): Promise<void> | void;
}

/** The single global guard. Checks run in a fixed order; the first failure throws. */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly steps: AccessCheck[];

  constructor(realm: RealmCheck) {
    this.steps = [realm];
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithContext>();
    for (const step of this.steps) await step.check(ctx, req);
    return true;
  }
}
```

`backend/src/modules/access/access.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessGuard } from './access.guard.js';
import { RealmCheck } from './checks/realm.check.js';
import { TenantResolverService } from './tenant-resolver.service.js';

@Global()
@Module({
  providers: [TenantResolverService, RealmCheck, { provide: APP_GUARD, useClass: AccessGuard }],
  exports: [TenantResolverService],
})
export class AccessModule {}
```

`backend/src/modules/health/health.controller.ts`: add the decorators at class level so health works on any host without auth:
```ts
import { Public, Realm } from '../access/decorators.js';
// …
@Realm('any')
@Public()
@Controller('health')
export class HealthController {
```

`backend/src/configure-app.ts`: register the resolver right after the correlation middleware:
```ts
import { TenantResolverService } from './modules/access/tenant-resolver.service.js';
// …
  app.use(correlationMiddleware);
  app.use(app.get(TenantResolverService).middleware);
```

`backend/src/app.module.ts`: add `AccessModule` to `imports` (after `AuditModule`) with `import { AccessModule } from './modules/access/access.module.js';`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS (the earlier `health.e2e.spec.ts` keeps passing because health is `@Realm('any') @Public()`; its 404 test still gets `NOT_FOUND` because unknown routes never reach the guard).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/access backend/src/configure-app.ts backend/src/app.module.ts backend/src/modules/health backend/test
git commit -m "feat(access): host-based tenant resolution, realm routing, global access guard"
```

---

### Task 9: Tenant authentication — password, MFA, setup codes, refresh rotation

**Files:**
- Create: `backend/src/modules/identity/lockout.service.ts`, `backend/src/modules/identity/session.service.ts`, `backend/src/modules/identity/auth.service.ts`, `backend/src/modules/identity/auth.controller.ts`, `backend/src/modules/identity/cookies.ts`, `backend/src/modules/identity/identity.module.ts`
- Create: `backend/src/modules/access/checks/auth.check.ts`
- Modify: `backend/src/modules/access/access.guard.ts`, `backend/src/modules/access/access.module.ts`, `backend/src/app.module.ts`
- Modify: `backend/test/helpers/fixtures.ts` (add `createUser`, `createSuperAdmin` comes in Task 13)
- Create: `backend/test/helpers/http.ts`
- Test: `backend/test/auth.e2e.spec.ts`

**Interfaces:**
- Consumes: `TenantDb`, `PasswordService`, `TokenService`, `RevocationStore`, `Aead`, `RateLimiter`, `AuditService`, `requestMeta`, `auditContext`, `otpauthUrl`, `verifyTotp`, `base32Encode`, `randomToken`, `sha256Hex`.
- Produces:
  - `ACCESS_TTL_SEC = 300`, `REFRESH_IDLE_MS = 12h`, `REFRESH_ABSOLUTE_MS = 7d` (exported from `session.service.ts`).
  - `interface IssuedSession { accessToken: string; refreshToken: string; familyId: string }`.
  - `SessionService.start(tx: Tx, input: { tenantId: string; userId: string; deviceId?: string | null }): Promise<IssuedSession>`, `.rotate(tenantId: string, refreshToken: string, deviceId?: string | null): Promise<IssuedSession>`, `.revoke(tenantId: string, familyId: string): Promise<void>`, `.revokeWhere(tx: Tx, where: { userId?: string; deviceId?: string }): Promise<string[]>` (returns revoked family ids; caller marks them in `RevocationStore`).
  - `LockoutService.assertNotLocked(lockedUntil: Date | null): void` (throws `ACCOUNT_LOCKED` 423), `.recordFailure(tenantId, userId, kind: 'password' | 'pin', entry: Partial<AuditEntry>): Promise<void>`, `.resetInTx(tx, userId, kind): Promise<void>`; constants `MAX_FAILURES = 5`, `LOCK_MS = 15 min`.
  - `type LoginResult = { status: 'ok'; session: IssuedSession } | { status: 'mfa_required'; mfaToken: string } | { status: 'mfa_setup_required'; mfaToken: string; otpauthUrl: string; secret: string }`.
  - `AuthService.login(tenant, { email, password }, meta)`, `.verifyMfa(tenant, { mfaToken, code }, meta): Promise<IssuedSession>`, `.setupPassword(tenant, { code, password }, meta): Promise<void>`.
  - Routes (tenant host): `POST /api/auth/login`, `POST /api/auth/mfa/verify`, `POST /api/auth/setup-password` (204), `POST /api/auth/refresh`, `POST /api/auth/logout` (204, authed).
  - `REFRESH_COOKIE = 'pos_rt'`, `setRefreshCookie(res, token, path)`, `clearRefreshCookie(res, path)`.
  - `AuthCheck` (sets `req.principal`; enforces audience by route realm, tenant match, session revocation).
  - Test helpers: `createUser(tenantId, UserFixture)` → `{ user, role }`; `http.ts`: `refreshCookie(res): string | undefined`, `bearer(token): Record<string, string>`, `loginPassword(app, slug, email, password): Promise<string>` (returns access token, for users without MFA).

- [ ] **Step 1: Fixtures and HTTP helpers**

Append to `backend/test/helpers/fixtures.ts` (move the new `import` lines to the top of the file, next to the existing imports):
```ts
import type { Permission } from '@pos/shared';
import { Aead } from '../../src/common/crypto/aead.js';
import { sha256Hex } from '../../src/common/crypto/hash.js';
import { PasswordService } from '../../src/security/password.service.js';

const passwords = new PasswordService();
export const testAead = () => new Aead(Buffer.from(process.env.PII_KEY!, 'base64'));

export interface UserFixture {
  name?: string;
  email?: string;
  password?: string;
  pin?: string;
  permissions?: Permission[];
  requiresMfa?: boolean;
  /** Raw TOTP secret; stored encrypted like the app does. */
  totpSecret?: Buffer;
  /** One-time setup code (plaintext); stored hashed, valid 1 h. */
  setupCode?: string;
}

export async function createUser(tenantId: string, input: UserFixture = {}) {
  const db = ownerDb();
  const role = await db.role.create({
    data: { tenantId, name: `role-${uuidv7()}`, permissions: input.permissions ?? [], requiresMfa: input.requiresMfa ?? false },
  });
  const user = await db.user.create({
    data: {
      tenantId,
      name: input.name ?? 'Test User',
      email: input.email?.toLowerCase(),
      passwordHash: input.password ? await passwords.hash(input.password) : null,
      pinHash: input.pin ? await passwords.hash(input.pin) : null,
      totpSecretEnc: input.totpSecret ? testAead().encrypt(input.totpSecret.toString('base64')) : null,
      setupTokenHash: input.setupCode ? sha256Hex(input.setupCode) : null,
      setupTokenExpiresAt: input.setupCode ? new Date(Date.now() + 3_600_000) : null,
    },
  });
  await db.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
  return { user, role };
}
```

`backend/test/helpers/http.ts`:
```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { hostFor } from './fixtures.js';

export function refreshCookie(res: Response): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = raw?.find((v) => v.startsWith('pos_rt='));
  return c?.split(';')[0].slice('pos_rt='.length) || undefined;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Password login for a user without MFA. Returns the access token. */
export async function loginPassword(app: NestExpressApplication, slug: string, email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/api/auth/login').set('Host', hostFor(slug)).send({ email, password }).expect(200);
  if (res.body.status !== 'ok') throw new Error(`expected ok login, got ${res.body.status}`);
  return res.body.accessToken as string;
}
```

- [ ] **Step 2: Write the failing tests**

`backend/test/auth.e2e.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode } from '../src/common/crypto/base32.js';
import { hotp, totp, totpCounter } from '../src/common/crypto/totp.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword, refreshCookie } from './helpers/http.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('tenant authentication', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme' })).id;
  });

  describe('password login', () => {
    it('issues an access token and a hardened refresh cookie', async () => {
      const { user } = await createUser(tenantId, { email: 'cashier@acme.lk', password: PW });
      const res = await http().post('/api/auth/login').set('Host', host).send({ email: 'CASHIER@acme.lk', password: PW }).expect(200);
      expect(res.body.status).toBe('ok');
      const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pos_rt='))!;
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api\/auth/);
      const me = await http().get('/api/probe/authed').set('Host', host).set(bearer(res.body.accessToken)).expect(200);
      expect(me.body).toMatchObject({ realm: 'tenant', userId: user.id, tenantId });
    });

    it('gives the same answer for unknown email and wrong password', async () => {
      await createUser(tenantId, { email: 'a@acme.lk', password: PW });
      const wrong = await http().post('/api/auth/login').set('Host', host).send({ email: 'a@acme.lk', password: 'nope' }).expect(401);
      const unknown = await http().post('/api/auth/login').set('Host', host).send({ email: 'z@acme.lk', password: 'nope' }).expect(401);
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('locks the account after 5 failures, even for the right password', async () => {
      await createUser(tenantId, { email: 'a@acme.lk', password: PW });
      for (let i = 0; i < 5; i++) await http().post('/api/auth/login').set('Host', host).send({ email: 'a@acme.lk', password: 'bad' }).expect(401);
      const res = await http().post('/api/auth/login').set('Host', host).send({ email: 'a@acme.lk', password: PW }).expect(423);
      expect(res.body.code).toBe('ACCOUNT_LOCKED');
      const events = await ownerDb().auditEvent.findMany({ where: { action: 'auth.password_failed' } });
      expect(events).toHaveLength(5);
    });

    it('rate-limits repeated attempts on one email', async () => {
      for (let i = 0; i < 10; i++) await http().post('/api/auth/login').set('Host', host).send({ email: 'x@acme.lk', password: 'bad' });
      const res = await http().post('/api/auth/login').set('Host', host).send({ email: 'x@acme.lk', password: 'bad' }).expect(429);
      expect(res.body.code).toBe('RATE_LIMITED');
    });

    it('rejects requests without a token and with a garbage token', async () => {
      await http().get('/api/probe/authed').set('Host', host).expect(401);
      await http().get('/api/probe/authed').set('Host', host).set(bearer('garbage')).expect(401);
    });
  });

  describe('MFA', () => {
    it('enrols TOTP on first login when a role requires MFA, then requires it', async () => {
      await createUser(tenantId, { email: 'mgr@acme.lk', password: PW, requiresMfa: true });
      const first = await http().post('/api/auth/login').set('Host', host).send({ email: 'mgr@acme.lk', password: PW }).expect(200);
      expect(first.body.status).toBe('mfa_setup_required');
      expect(first.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      const secret = base32Decode(first.body.secret);
      const enrolmentCode = totp(secret);

      const verified = await http().post('/api/auth/mfa/verify').set('Host', host).send({ mfaToken: first.body.mfaToken, code: enrolmentCode }).expect(200);
      expect(verified.body.accessToken).toBeTruthy();
      expect(refreshCookie(verified)).toBeTruthy();

      const second = await http().post('/api/auth/login').set('Host', host).send({ email: 'mgr@acme.lk', password: PW }).expect(200);
      expect(second.body).toEqual({ status: 'mfa_required', mfaToken: expect.any(String) });
      // The code used for enrolment cannot be replayed.
      await http().post('/api/auth/mfa/verify').set('Host', host).send({ mfaToken: second.body.mfaToken, code: enrolmentCode }).expect(401);
      // The next step's code works.
      const next = hotp(secret, totpCounter(Date.now()) + 1);
      await http().post('/api/auth/mfa/verify').set('Host', host).send({ mfaToken: second.body.mfaToken, code: next }).expect(200);
    });

    it('rejects an MFA token presented on another tenant host', async () => {
      await createTenant({ slug: 'other' });
      const secret = randomBytes(20);
      await createUser(tenantId, { email: 'mgr@acme.lk', password: PW, requiresMfa: true, totpSecret: secret });
      const login = await http().post('/api/auth/login').set('Host', host).send({ email: 'mgr@acme.lk', password: PW }).expect(200);
      await http().post('/api/auth/mfa/verify').set('Host', hostFor('other')).send({ mfaToken: login.body.mfaToken, code: totp(secret) }).expect(401);
    });
  });

  describe('setup codes', () => {
    it('sets the password once with a valid code', async () => {
      await createUser(tenantId, { email: 'new@acme.lk', setupCode: 'setup-code-1234567890' });
      await http().post('/api/auth/setup-password').set('Host', host).send({ code: 'setup-code-1234567890', password: PW }).expect(204);
      await loginPassword(app, 'acme', 'new@acme.lk', PW);
      await http().post('/api/auth/setup-password').set('Host', host).send({ code: 'setup-code-1234567890', password: PW }).expect(401);
    });

    it('rejects short passwords', async () => {
      await createUser(tenantId, { email: 'new@acme.lk', setupCode: 'setup-code-1234567890' });
      const res = await http().post('/api/auth/setup-password').set('Host', host).send({ code: 'setup-code-1234567890', password: 'short' }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('refresh rotation', () => {
    async function login() {
      await createUser(tenantId, { email: 'a@acme.lk', password: PW });
      const res = await http().post('/api/auth/login').set('Host', host).send({ email: 'a@acme.lk', password: PW }).expect(200);
      return refreshCookie(res)!;
    }

    it('rotates the refresh token', async () => {
      const rt1 = await login();
      const res = await http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt1}`).expect(200);
      const rt2 = refreshCookie(res)!;
      expect(rt2).not.toBe(rt1);
      expect(res.body.accessToken).toBeTruthy();
    });

    it('revokes the whole family when a used token is replayed', async () => {
      const rt1 = await login();
      const res = await http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt1}`).expect(200);
      const rt2 = refreshCookie(res)!;
      const access2 = res.body.accessToken as string;
      await http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt1}`).expect(401);
      await http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt2}`).expect(401);
      await http().get('/api/probe/authed').set('Host', host).set(bearer(access2)).expect(401);
      expect(await ownerDb().auditEvent.count({ where: { action: 'auth.refresh_reuse' } })).toBe(1);
    });

    it('concurrent refresh: exactly one succeeds', async () => {
      const rt1 = await login();
      const results = await Promise.all(
        [0, 1].map(() => http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt1}`)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it('refuses refresh tokens on another tenant host', async () => {
      await createTenant({ slug: 'other' });
      const rt1 = await login();
      await http().post('/api/auth/refresh').set('Host', hostFor('other')).set('Cookie', `pos_rt=${rt1}`).expect(401);
    });
  });

  it('logout revokes the session immediately', async () => {
    await createUser(tenantId, { email: 'a@acme.lk', password: PW });
    const token = await loginPassword(app, 'acme', 'a@acme.lk', PW);
    await http().post('/api/auth/logout').set('Host', host).set(bearer(token)).expect(204);
    await http().get('/api/probe/authed').set('Host', host).set(bearer(token)).expect(401);
  });

  it('a token for tenant A is refused on tenant B and audited in B', async () => {
    const b = await createTenant({ slug: 'bravo' });
    await createUser(tenantId, { email: 'a@acme.lk', password: PW });
    const token = await loginPassword(app, 'acme', 'a@acme.lk', PW);
    const res = await http().get('/api/probe/authed').set('Host', hostFor('bravo')).set(bearer(token)).expect(403);
    expect(res.body.code).toBe('TENANT_MISMATCH');
    expect(await ownerDb().auditEvent.count({ where: { tenantId: b.id, action: 'auth.tenant_mismatch' } })).toBe(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w backend -- test/auth.e2e.spec.ts`
Expected: FAIL — `/api/auth/login` 404; `/api/probe/authed` returns 200 with empty body (no auth check yet).

- [ ] **Step 4: Implement**

`backend/src/modules/identity/cookies.ts`:
```ts
import type { Response } from 'express';
import { REFRESH_ABSOLUTE_MS } from './session.service.js';

export const REFRESH_COOKIE = 'pos_rt';
export const TENANT_COOKIE_PATH = '/api/auth';
export const PLATFORM_COOKIE_PATH = '/api/platform/auth';

const base = { httpOnly: true, secure: true, sameSite: 'strict' as const };

export function setRefreshCookie(res: Response, token: string, path: string) {
  res.cookie(REFRESH_COOKIE, token, { ...base, path, maxAge: REFRESH_ABSOLUTE_MS });
}

export function clearRefreshCookie(res: Response, path: string) {
  res.clearCookie(REFRESH_COOKIE, { ...base, path });
}
```

`backend/src/modules/identity/session.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { randomToken, sha256Hex } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { RevocationStore } from '../../security/revocation.store.js';
import { TokenService } from '../../security/token.service.js';
import { AuditService } from '../audit/audit.service.js';

export const ACCESS_TTL_SEC = 300;
export const REFRESH_IDLE_MS = 12 * 3_600_000;
export const REFRESH_ABSOLUTE_MS = 7 * 24 * 3_600_000;

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  familyId: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly tokens: TokenService,
    private readonly revocations: RevocationStore,
    private readonly audit: AuditService,
  ) {}

  async start(tx: Tx, input: { tenantId: string; userId: string; deviceId?: string | null }): Promise<IssuedSession> {
    const family = await tx.refreshFamily.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        deviceId: input.deviceId ?? null,
        absoluteExpiresAt: new Date(Date.now() + REFRESH_ABSOLUTE_MS),
      },
    });
    return this.issue(tx, input.tenantId, family.id, input.userId, family.deviceId);
  }

  private async issue(tx: Tx, tenantId: string, familyId: string, userId: string, deviceId: string | null): Promise<IssuedSession> {
    const refreshToken = randomToken();
    await tx.refreshToken.create({
      data: { tenantId, familyId, tokenHash: sha256Hex(refreshToken), expiresAt: new Date(Date.now() + REFRESH_IDLE_MS) },
    });
    const accessToken = await this.tokens.sign(
      'tenant',
      { sub: userId, tid: tenantId, sid: familyId, ...(deviceId ? { did: deviceId } : {}) },
      ACCESS_TTL_SEC,
    );
    return { accessToken, refreshToken, familyId };
  }

  /**
   * deviceId: the verified device making the request (null if unsigned). A device-bound session can
   * only be refreshed by the same device, so a stolen till cookie is useless elsewhere.
   */
  async rotate(tenantId: string, refreshToken: string, deviceId: string | null = null): Promise<IssuedSession> {
    const now = new Date();
    const outcome = await this.tenantDb.run(tenantId, async (tx) => {
      const token = await tx.refreshToken.findUnique({ where: { tokenHash: sha256Hex(refreshToken) }, include: { family: true } });
      if (!token || token.family.revokedAt || token.family.absoluteExpiresAt <= now || token.expiresAt <= now) {
        return { kind: 'invalid' as const };
      }
      if (token.family.deviceId && token.family.deviceId !== deviceId) return { kind: 'invalid' as const };
      // Atomic claim: under concurrency only one caller flips usedAt; the other sees reuse.
      const claimed = await tx.refreshToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count === 0) {
        await tx.refreshFamily.update({ where: { id: token.familyId }, data: { revokedAt: now } });
        await this.audit.record(tx, tenantId, {
          action: 'auth.refresh_reuse',
          entityType: 'RefreshFamily',
          entityId: token.familyId,
          actorUserId: token.family.userId,
        });
        return { kind: 'reuse' as const, familyId: token.familyId };
      }
      const session = await this.issue(tx, tenantId, token.familyId, token.family.userId, token.family.deviceId);
      return { kind: 'ok' as const, session };
    });
    if (outcome.kind === 'reuse') await this.revocations.markRevoked(outcome.familyId, ACCESS_TTL_SEC);
    if (outcome.kind !== 'ok') throw AppError.unauthenticated('Session expired');
    return outcome.session;
  }

  async revoke(tenantId: string, familyId: string): Promise<void> {
    await this.tenantDb.run(tenantId, (tx) =>
      tx.refreshFamily.updateMany({ where: { id: familyId, revokedAt: null }, data: { revokedAt: new Date() } }),
    );
    await this.revocations.markRevoked(familyId, ACCESS_TTL_SEC);
  }

  /** Revokes matching live families inside the caller's tenant transaction. Caller must markRevoked the ids. */
  async revokeWhere(tx: Tx, where: { userId?: string; deviceId?: string }): Promise<string[]> {
    const families = await tx.refreshFamily.findMany({ where: { ...where, revokedAt: null }, select: { id: true } });
    if (families.length) {
      await tx.refreshFamily.updateMany({ where: { id: { in: families.map((f) => f.id) } }, data: { revokedAt: new Date() } });
    }
    return families.map((f) => f.id);
  }
}
```

`backend/src/modules/identity/lockout.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { type AuditEntry, AuditService } from '../audit/audit.service.js';

export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

export type CredentialKind = 'password' | 'pin';

@Injectable()
export class LockoutService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  assertNotLocked(lockedUntil: Date | null) {
    if (lockedUntil && lockedUntil > new Date()) throw new AppError('ACCOUNT_LOCKED', 423, 'Account temporarily locked');
  }

  /** Counts a failure in its own transaction (it must survive the request failing). */
  async recordFailure(tenantId: string, userId: string, kind: CredentialKind, entry: Partial<AuditEntry> = {}) {
    await this.tenantDb.run(tenantId, async (tx) => {
      const user =
        kind === 'password'
          ? await tx.user.update({ where: { id: userId }, data: { failedLoginCount: { increment: 1 } } })
          : await tx.user.update({ where: { id: userId }, data: { pinFailedCount: { increment: 1 } } });
      const count = kind === 'password' ? user.failedLoginCount : user.pinFailedCount;
      if (count >= MAX_FAILURES) {
        const until = new Date(Date.now() + LOCK_MS);
        await tx.user.update({
          where: { id: userId },
          data: kind === 'password' ? { failedLoginCount: 0, lockedUntil: until } : { pinFailedCount: 0, pinLockedUntil: until },
        });
      }
      await this.audit.record(tx, tenantId, { ...entry, action: `auth.${kind}_failed`, entityType: 'User', entityId: userId });
    });
  }

  async resetInTx(tx: Tx, userId: string, kind: CredentialKind) {
    await tx.user.update({
      where: { id: userId },
      data: kind === 'password' ? { failedLoginCount: 0, lockedUntil: null } : { pinFailedCount: 0, pinLockedUntil: null },
    });
  }
}
```

`backend/src/modules/identity/auth.service.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { LoginSchema, MfaVerifySchema, SetupPasswordSchema } from '@pos/shared';
import type { z } from 'zod';
import { Aead } from '../../common/crypto/aead.js';
import { base32Encode } from '../../common/crypto/base32.js';
import { sha256Hex } from '../../common/crypto/hash.js';
import { otpauthUrl, verifyTotp } from '../../common/crypto/totp.js';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { RateLimiter } from '../../infra/rate-limiter.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { PasswordService } from '../../security/password.service.js';
import { TokenService } from '../../security/token.service.js';
import type { RequestMeta } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { LockoutService } from './lockout.service.js';
import { type IssuedSession, SessionService } from './session.service.js';

export type LoginResult =
  | { status: 'ok'; session: IssuedSession }
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_setup_required'; mfaToken: string; otpauthUrl: string; secret: string };

interface MfaClaims {
  tid: string;
  purpose: 'verify' | 'setup';
  /** Encrypted pending secret, only for purpose=setup. */
  sec?: string;
}

const INVALID_LOGIN = 'Invalid email or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly lockout: LockoutService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly aead: Aead,
  ) {}

  async login(tenant: TenantContext, input: z.infer<typeof LoginSchema>, meta: RequestMeta): Promise<LoginResult> {
    const allowed =
      (await this.limiter.consume(`login:${tenant.id}:${input.email}`, 10, 900)) &&
      (await this.limiter.consume(`login-ip:${meta.ip}`, 50, 900));
    if (!allowed) throw AppError.rateLimited();

    const user = await this.tenantDb.run(tenant.id, (tx) =>
      tx.user.findFirst({ where: { email: input.email, status: 'ACTIVE' }, include: { roles: { include: { role: true } } } }),
    );
    if (user) this.lockout.assertNotLocked(user.lockedUntil);
    const ok = await this.passwords.verify(user?.passwordHash, input.password);
    if (!user || !ok) {
      if (user) await this.lockout.recordFailure(tenant.id, user.id, 'password', meta);
      throw AppError.unauthenticated(INVALID_LOGIN);
    }

    const mfaRequired = user.totpSecretEnc !== null || user.roles.some((r) => r.role.requiresMfa);
    if (!mfaRequired) {
      const session = await this.tenantDb.run(tenant.id, async (tx) => {
        await this.lockout.resetInTx(tx, user.id, 'password');
        const s = await this.sessions.start(tx, { tenantId: tenant.id, userId: user.id });
        await this.audit.record(tx, tenant.id, { ...meta, action: 'auth.login', entityType: 'User', entityId: user.id, actorUserId: user.id });
        return s;
      });
      return { status: 'ok', session };
    }

    await this.tenantDb.run(tenant.id, (tx) => this.lockout.resetInTx(tx, user.id, 'password'));
    if (user.totpSecretEnc) {
      return { status: 'mfa_required', mfaToken: await this.tokens.sign('mfa', { sub: user.id, tid: tenant.id, purpose: 'verify' }, 300) };
    }
    const secret = randomBytes(20);
    const mfaToken = await this.tokens.sign(
      'mfa',
      { sub: user.id, tid: tenant.id, purpose: 'setup', sec: this.aead.encrypt(secret.toString('base64')) },
      600,
    );
    return { status: 'mfa_setup_required', mfaToken, otpauthUrl: otpauthUrl('POS', user.email ?? user.id, secret), secret: base32Encode(secret) };
  }

  async verifyMfa(tenant: TenantContext, input: z.infer<typeof MfaVerifySchema>, meta: RequestMeta): Promise<IssuedSession> {
    const claims = await this.tokens.verify<MfaClaims>(input.mfaToken, 'mfa');
    if (claims.tid !== tenant.id) throw AppError.unauthenticated('Invalid or expired token');
    if (!(await this.limiter.consume(`mfa:${claims.sub}`, 5, 300))) throw AppError.rateLimited();

    return this.tenantDb.run(tenant.id, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: claims.sub, status: 'ACTIVE' } });
      if (!user) throw AppError.unauthenticated('Invalid or expired token');

      let secretB64: string;
      if (claims.purpose === 'setup') {
        if (user.totpSecretEnc || !claims.sec) throw AppError.unauthenticated('MFA already enrolled; sign in again');
        secretB64 = this.aead.decrypt(claims.sec);
      } else {
        if (!user.totpSecretEnc) throw AppError.unauthenticated('MFA not enrolled');
        secretB64 = this.aead.decrypt(user.totpSecretEnc);
      }

      const counter = verifyTotp(Buffer.from(secretB64, 'base64'), input.code, Date.now(), user.totpLastCounter);
      if (counter === null) throw AppError.unauthenticated('Invalid code');

      await tx.user.update({
        where: { id: user.id },
        data: { totpLastCounter: counter, ...(claims.purpose === 'setup' ? { totpSecretEnc: this.aead.encrypt(secretB64) } : {}) },
      });
      const session = await this.sessions.start(tx, { tenantId: tenant.id, userId: user.id });
      await this.audit.record(tx, tenant.id, {
        ...meta,
        action: claims.purpose === 'setup' ? 'auth.mfa_enrolled' : 'auth.login',
        entityType: 'User',
        entityId: user.id,
        actorUserId: user.id,
      });
      return session;
    });
  }

  async setupPassword(tenant: TenantContext, input: z.infer<typeof SetupPasswordSchema>, meta: RequestMeta): Promise<void> {
    if (!(await this.limiter.consume(`setup-ip:${meta.ip}`, 10, 900))) throw AppError.rateLimited();
    const passwordHash = await this.passwords.hash(input.password);
    await this.tenantDb.run(tenant.id, async (tx) => {
      const user = await tx.user.findFirst({
        where: { setupTokenHash: sha256Hex(input.code), setupTokenExpiresAt: { gt: new Date() }, status: 'ACTIVE' },
      });
      if (!user) throw AppError.unauthenticated('Invalid or expired setup code');
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, setupTokenHash: null, setupTokenExpiresAt: null } });
      await this.audit.record(tx, tenant.id, { ...meta, action: 'auth.password_set', entityType: 'User', entityId: user.id, actorUserId: user.id });
    });
  }
}
```

`backend/src/modules/identity/auth.controller.ts`:
```ts
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { LoginSchema, MfaVerifySchema, SetupPasswordSchema } from '@pos/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Public } from '../access/decorators.js';
import { requestMeta } from '../audit/audit-context.js';
import { AuthService } from './auth.service.js';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie, TENANT_COOKIE_PATH } from './cookies.js';
import { SessionService } from './session.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: RequestWithContext,
    @Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(req.tenant!, body, requestMeta(req));
    if (result.status !== 'ok') return result;
    setRefreshCookie(res, result.session.refreshToken, TENANT_COOKIE_PATH);
    return { status: 'ok', accessToken: result.session.accessToken };
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(
    @Req() req: RequestWithContext,
    @Body(new ZodPipe(MfaVerifySchema)) body: z.infer<typeof MfaVerifySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.verifyMfa(req.tenant!, body, requestMeta(req));
    setRefreshCookie(res, session.refreshToken, TENANT_COOKIE_PATH);
    return { status: 'ok', accessToken: session.accessToken };
  }

  @Public()
  @Post('setup-password')
  @HttpCode(204)
  async setupPassword(@Req() req: RequestWithContext, @Body(new ZodPipe(SetupPasswordSchema)) body: z.infer<typeof SetupPasswordSchema>) {
    await this.auth.setupPassword(req.tenant!, body, requestMeta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw AppError.unauthenticated('No session');
    const session = await this.sessions.rotate(req.tenant!.id, token, req.device?.id ?? null);
    setRefreshCookie(res, session.refreshToken, TENANT_COOKIE_PATH);
    return { accessToken: session.accessToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response) {
    if (req.principal?.sessionId) await this.sessions.revoke(req.tenant!.id, req.principal.sessionId);
    clearRefreshCookie(res, TENANT_COOKIE_PATH);
  }
}
```

`backend/src/modules/identity/identity.module.ts`:
```ts
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
```

`backend/src/modules/access/checks/auth.check.ts`:
```ts
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import { TenantDb } from '../../../infra/tenant-db.service.js';
import { RevocationStore } from '../../../security/revocation.store.js';
import { type AccessClaims, TokenService } from '../../../security/token.service.js';
import { auditContext } from '../../audit/audit-context.js';
import { AuditService } from '../../audit/audit.service.js';
import type { AccessCheck } from '../access.guard.js';
import { PUBLIC_KEY, routeMeta, routeRealm } from '../decorators.js';

@Injectable()
export class AuthCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly revocations: RevocationStore,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    if (routeMeta<boolean>(this.reflector, PUBLIC_KEY, ctx)) return;
    const realm = routeRealm(this.reflector, ctx);
    if (realm === 'any') throw AppError.unauthenticated(); // realm-any routes must be @Public

    const match = /^Bearer (\S+)$/.exec(req.header('authorization') ?? '');
    if (!match) throw AppError.unauthenticated();
    const claims = await this.tokens.verify<AccessClaims>(match[1], realm);
    if (claims.sid && (await this.revocations.isRevoked(claims.sid))) throw AppError.unauthenticated('Session revoked');

    if (realm === 'tenant' && claims.tid !== req.tenant!.id) {
      const tenantId = req.tenant!.id;
      await this.tenantDb.run(tenantId, (tx) =>
        this.audit.record(tx, tenantId, {
          ...auditContext(req),
          action: 'auth.tenant_mismatch',
          entityType: 'Tenant',
          entityId: tenantId,
          after: { tokenTenantId: claims.tid ?? null, tokenSubject: claims.sub },
        }),
      );
      throw new AppError('TENANT_MISMATCH', 403, 'Token is not valid for this tenant');
    }

    req.principal = {
      realm,
      userId: claims.sub,
      tenantId: claims.tid,
      sessionId: claims.sid,
      deviceId: claims.did,
      impersonatorId: claims.imp,
    };
  }
}
```

`backend/src/modules/access/access.guard.ts` (replace the constructor; rest unchanged):
```ts
import { AuthCheck } from './checks/auth.check.js';
import { RealmCheck } from './checks/realm.check.js';
// …
  constructor(realm: RealmCheck, auth: AuthCheck) {
    this.steps = [realm, auth];
  }
```

`backend/src/modules/access/access.module.ts`: add `AuthCheck` to `providers` (import from `./checks/auth.check.js`).

`backend/src/app.module.ts`: add `IdentityModule` to `imports` (after `AccessModule`) with `import { IdentityModule } from './modules/identity/identity.module.js';`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS. `tenant-resolution.e2e.spec.ts` still passes because every probe route it calls is `@Public()`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/identity backend/src/modules/access backend/src/app.module.ts backend/test
git commit -m "feat(identity): password + TOTP login, setup codes, rotating refresh tokens with reuse detection"
```

---
### Task 10: Tenant status, module and permission enforcement; `/me`

**Files:**
- Create: `backend/src/modules/access/capabilities.service.ts`, `backend/src/modules/access/plan-limits.service.ts`
- Create: `backend/src/modules/access/checks/tenant-status.check.ts`, `backend/src/modules/access/checks/module.check.ts`, `backend/src/modules/access/checks/permission.check.ts`
- Modify: `backend/src/modules/access/access.guard.ts`, `backend/src/modules/access/access.module.ts`
- Create: `backend/src/modules/backoffice/me.controller.ts`, `backend/src/modules/backoffice/backoffice.module.ts`
- Modify: `backend/src/app.module.ts`
- Test: `backend/test/access.e2e.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `TenantDb`, `RedisService`, `resolveModules`, `PERMISSIONS`, decorators from Task 8.
- Produces:
  - `CapabilitiesService.modulesFor(tenant: Pick<TenantContext, 'id' | 'businessTypeId'>): Promise<ModuleKey[]>` (Redis-cached 60 s), `.invalidateModules(tenantIds: string[]): Promise<void>`, `.permissionsFor(tenantId: string, userId: string): Promise<Set<Permission>>` (empty for disabled users; never cached).
  - `type LimitedResource = 'stores' | 'devices' | 'users'`; `PlanLimitsService.assertCanAdd(tx: Tx, tenant: Pick<TenantContext, 'planId'>, resource: LimitedResource): Promise<void>` (throws `PLAN_LIMIT_REACHED` 403).
  - `TenantStatusCheck`, `ModuleCheck`, `PermissionCheck`.
  - Guard order after this task: realm → tenant status → auth → module → permission.
  - Routes: `GET /api/me` → `{ user: { id, name, email }, tenant: { id, name, slug }, impersonatedBy: string | null, deviceId: string | null }`; `GET /api/me/capabilities` → `{ modules: ModuleKey[], permissions: Permission[], impersonatedBy: string | null }`.
  - `BackofficeModule` (later tasks add controllers here).

- [ ] **Step 1: Write the failing tests**

`backend/test/access.e2e.spec.ts`:
```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CapabilitiesService } from '../src/modules/access/capabilities.service.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('tenant status, modules, permissions', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
  });

  it('blocks every tenant route of a suspended tenant, including login', async () => {
    const t = await createTenant({ slug: 'acme', status: 'SUSPENDED' });
    await createUser(t.id, { email: 'a@acme.lk', password: PW });
    const res = await http().post('/api/auth/login').set('Host', host).send({ email: 'a@acme.lk', password: PW }).expect(403);
    expect(res.body.code).toBe('TENANT_SUSPENDED');
  });

  it('refuses routes of disabled modules and allows them once enabled', async () => {
    const t = await createTenant({ slug: 'acme', modules: ['core'] });
    await createUser(t.id, { email: 'a@acme.lk', password: PW });
    const token = await loginPassword(app, 'acme', 'a@acme.lk', PW);
    const denied = await http().get('/api/probe/tables').set('Host', host).set(bearer(token)).expect(403);
    expect(denied.body.code).toBe('MODULE_DISABLED');

    await ownerDb().tenantModule.create({ data: { tenantId: t.id, moduleKey: 'tables', enabled: true } });
    await app.get(CapabilitiesService).invalidateModules([t.id]);
    await http().get('/api/probe/tables').set('Host', host).set(bearer(token)).expect(200);
  });

  it('enforces route permissions', async () => {
    const t = await createTenant({ slug: 'acme' });
    await createUser(t.id, { email: 'cashier@acme.lk', password: PW, permissions: ['sale.create'] });
    await createUser(t.id, { email: 'mgr@acme.lk', password: PW, permissions: ['sale.refund'] });
    const cashier = await loginPassword(app, 'acme', 'cashier@acme.lk', PW);
    const mgr = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
    const res = await http().get('/api/probe/refund-permission').set('Host', host).set(bearer(cashier)).expect(403);
    expect(res.body.code).toBe('FORBIDDEN');
    await http().get('/api/probe/refund-permission').set('Host', host).set(bearer(mgr)).expect(200);
  });

  it('a disabled user keeps no permissions even with a live token', async () => {
    const t = await createTenant({ slug: 'acme' });
    const { user } = await createUser(t.id, { email: 'mgr@acme.lk', password: PW, permissions: ['sale.refund'] });
    const token = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
    await ownerDb().user.update({ where: { id: user.id }, data: { status: 'DISABLED' } });
    await http().get('/api/probe/refund-permission').set('Host', host).set(bearer(token)).expect(403);
  });

  it('GET /me and /me/capabilities describe the caller', async () => {
    const t = await createTenant({ slug: 'acme', modules: ['core', 'tables', 'modifiers'] });
    const { user } = await createUser(t.id, { email: 'mgr@acme.lk', password: PW, permissions: ['sale.refund', 'sale.create'] });
    const token = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
    const me = await http().get('/api/me').set('Host', host).set(bearer(token)).expect(200);
    expect(me.body).toEqual({
      user: { id: user.id, name: 'Test User', email: 'mgr@acme.lk' },
      tenant: { id: t.id, name: 'Tenant acme', slug: 'acme' },
      impersonatedBy: null,
      deviceId: null,
    });
    const caps = await http().get('/api/me/capabilities').set('Host', host).set(bearer(token)).expect(200);
    expect(caps.body).toEqual({ modules: ['core', 'modifiers', 'tables'], permissions: ['sale.create', 'sale.refund'], impersonatedBy: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/access.e2e.spec.ts`
Expected: FAIL — suspended login returns 200; `/api/probe/tables` returns 200; `/api/me` 404.

- [ ] **Step 3: Implement**

`backend/src/modules/access/capabilities.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { type ModuleKey, PERMISSIONS, type Permission, resolveModules } from '@pos/shared';
import type { TenantContext } from '../../common/request-context.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { RedisService } from '../../infra/redis.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';

const MODULE_CACHE_TTL_SEC = 60;
const VALID_PERMISSIONS = new Set<string>(PERMISSIONS);

@Injectable()
export class CapabilitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly redis: RedisService,
  ) {}

  async modulesFor(tenant: Pick<TenantContext, 'id' | 'businessTypeId'>): Promise<ModuleKey[]> {
    const key = `mods:${tenant.id}`;
    const cached = await this.redis.client.get(key);
    if (cached) return JSON.parse(cached) as ModuleKey[];
    const [bt, overrides] = await Promise.all([
      this.prisma.businessType.findUniqueOrThrow({ where: { id: tenant.businessTypeId }, select: { modules: true } }),
      this.prisma.tenantModule.findMany({ where: { tenantId: tenant.id }, select: { moduleKey: true, enabled: true } }),
    ]);
    const modules = resolveModules(bt.modules, overrides);
    await this.redis.client.set(key, JSON.stringify(modules), 'EX', MODULE_CACHE_TTL_SEC);
    return modules;
  }

  async invalidateModules(tenantIds: string[]): Promise<void> {
    if (tenantIds.length) await this.redis.client.del(...tenantIds.map((id) => `mods:${id}`));
  }

  /** Read on every check so role changes and disabling a user take effect immediately. */
  async permissionsFor(tenantId: string, userId: string): Promise<Set<Permission>> {
    const user = await this.tenantDb.run(tenantId, (tx) =>
      tx.user.findFirst({
        where: { id: userId, status: 'ACTIVE' },
        select: { roles: { select: { role: { select: { permissions: true } } } } },
      }),
    );
    const all = user?.roles.flatMap((r) => r.role.permissions) ?? [];
    return new Set(all.filter((p): p is Permission => VALID_PERMISSIONS.has(p)));
  }
}
```

`backend/src/modules/access/plan-limits.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';

export type LimitedResource = 'stores' | 'devices' | 'users';

@Injectable()
export class PlanLimitsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Call inside the tenant transaction that creates the resource. */
  async assertCanAdd(tx: Tx, tenant: Pick<TenantContext, 'planId'>, resource: LimitedResource): Promise<void> {
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id: tenant.planId } });
    let count: number;
    let max: number;
    if (resource === 'stores') {
      count = await tx.store.count();
      max = plan.maxStores;
    } else if (resource === 'devices') {
      count = await tx.device.count({ where: { revokedAt: null } });
      max = plan.maxDevices;
    } else {
      count = await tx.user.count({ where: { status: 'ACTIVE' } });
      max = plan.maxUsers;
    }
    if (count >= max) throw new AppError('PLAN_LIMIT_REACHED', 403, `Plan limit reached for ${resource}`, { resource, max });
  }
}
```

`backend/src/modules/access/checks/tenant-status.check.ts`:
```ts
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import type { AccessCheck } from '../access.guard.js';
import { routeRealm } from '../decorators.js';

@Injectable()
export class TenantStatusCheck implements AccessCheck {
  constructor(private readonly reflector: Reflector) {}

  check(ctx: ExecutionContext, req: RequestWithContext) {
    if (routeRealm(this.reflector, ctx) !== 'tenant') return;
    if (req.tenant?.status === 'SUSPENDED') throw new AppError('TENANT_SUSPENDED', 403, 'This account is suspended');
  }
}
```

`backend/src/modules/access/checks/module.check.ts`:
```ts
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ModuleKey } from '@pos/shared';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import type { AccessCheck } from '../access.guard.js';
import { CapabilitiesService } from '../capabilities.service.js';
import { MODULE_KEY, routeMeta } from '../decorators.js';

@Injectable()
export class ModuleCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly capabilities: CapabilitiesService,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    const required = routeMeta<ModuleKey>(this.reflector, MODULE_KEY, ctx);
    if (!required) return;
    if (!req.tenant || !(await this.capabilities.modulesFor(req.tenant)).includes(required)) {
      throw new AppError('MODULE_DISABLED', 403, `Module ${required} is not enabled`, { module: required });
    }
  }
}
```

`backend/src/modules/access/checks/permission.check.ts`:
```ts
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@pos/shared';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import type { AccessCheck } from '../access.guard.js';
import { CapabilitiesService } from '../capabilities.service.js';
import { PERMISSION_KEY, routeMeta } from '../decorators.js';

@Injectable()
export class PermissionCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly capabilities: CapabilitiesService,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    const required = routeMeta<Permission>(this.reflector, PERMISSION_KEY, ctx);
    if (!required) return;
    const p = req.principal;
    if (!p) throw AppError.unauthenticated();
    if (p.realm !== 'tenant' || !req.tenant) throw AppError.forbidden();
    const perms = await this.capabilities.permissionsFor(req.tenant.id, p.userId);
    if (!perms.has(required)) throw AppError.forbidden(`Missing permission ${required}`);
  }
}
```

`backend/src/modules/access/access.guard.ts` (replace the constructor):
```ts
import { AuthCheck } from './checks/auth.check.js';
import { ModuleCheck } from './checks/module.check.js';
import { PermissionCheck } from './checks/permission.check.js';
import { RealmCheck } from './checks/realm.check.js';
import { TenantStatusCheck } from './checks/tenant-status.check.js';
// …
  constructor(realm: RealmCheck, tenantStatus: TenantStatusCheck, auth: AuthCheck, modules: ModuleCheck, permissions: PermissionCheck) {
    this.steps = [realm, tenantStatus, auth, modules, permissions];
  }
```

`backend/src/modules/access/access.module.ts` (replace):
```ts
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessGuard } from './access.guard.js';
import { CapabilitiesService } from './capabilities.service.js';
import { AuthCheck } from './checks/auth.check.js';
import { ModuleCheck } from './checks/module.check.js';
import { PermissionCheck } from './checks/permission.check.js';
import { RealmCheck } from './checks/realm.check.js';
import { TenantStatusCheck } from './checks/tenant-status.check.js';
import { PlanLimitsService } from './plan-limits.service.js';
import { TenantResolverService } from './tenant-resolver.service.js';

@Global()
@Module({
  providers: [
    TenantResolverService,
    CapabilitiesService,
    PlanLimitsService,
    RealmCheck,
    TenantStatusCheck,
    AuthCheck,
    ModuleCheck,
    PermissionCheck,
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [TenantResolverService, CapabilitiesService, PlanLimitsService],
})
export class AccessModule {}
```

`backend/src/modules/backoffice/me.controller.ts`:
```ts
import { Controller, Get, Req } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';

@Controller('me')
export class MeController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly capabilities: CapabilitiesService,
  ) {}

  @Get()
  async me(@Req() req: RequestWithContext) {
    const p = req.principal!;
    const tenant = req.tenant!;
    const user = await this.tenantDb.run(tenant.id, (tx) =>
      tx.user.findFirst({ where: { id: p.userId, status: 'ACTIVE' }, select: { id: true, name: true, email: true } }),
    );
    if (!user) throw AppError.unauthenticated();
    return {
      user,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      impersonatedBy: p.impersonatorId ?? null,
      deviceId: p.deviceId ?? null,
    };
  }

  @Get('capabilities')
  async capabilities(@Req() req: RequestWithContext) {
    const [modules, permissions] = await Promise.all([
      this.capabilities.modulesFor(req.tenant!),
      this.capabilities.permissionsFor(req.tenant!.id, req.principal!.userId),
    ]);
    return { modules, permissions: [...permissions].sort(), impersonatedBy: req.principal!.impersonatorId ?? null };
  }
}
```

`backend/src/modules/backoffice/backoffice.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { MeController } from './me.controller.js';

@Module({ controllers: [MeController] })
export class BackofficeModule {}
```

`backend/src/app.module.ts`: add `BackofficeModule` to `imports` (after `IdentityModule`) with `import { BackofficeModule } from './modules/backoffice/backoffice.module.js';`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/access backend/src/modules/backoffice backend/src/app.module.ts backend/test/access.e2e.spec.ts
git commit -m "feat(access): tenant status, module and permission enforcement; /me endpoints"
```

---

### Task 11: Device enrollment and signed requests

**Files:**
- Create: `backend/src/security/device-signature.ts`
- Create: `backend/src/modules/access/checks/device.check.ts`
- Create: `backend/src/modules/identity/devices.service.ts`, `backend/src/modules/identity/devices.controller.ts`
- Modify: `backend/src/modules/access/access.guard.ts`, `backend/src/modules/access/access.module.ts`, `backend/src/modules/identity/identity.module.ts`
- Create: `backend/test/helpers/device.ts`
- Test: `backend/test/devices.e2e.spec.ts`

**Interfaces:**
- Consumes: `buildSigningPayload`, `DEVICE_HEADERS`, `CreateEnrollmentSchema`, `EnrollDeviceSchema` (shared); `NonceStore`, `TenantDb`, `PlanLimitsService`, `SessionService.revokeWhere`, `RevocationStore`, `RateLimiter`, `AuditService`, `auditContext`, `requestMeta`, `randomCode`, `sha256Hex`.
- Produces:
  - `interface DevicePublicJwk { kty: 'EC'; crv: 'P-256'; x: string; y: string }`, `importDeviceKey(jwk)`, `verifyDeviceSignature(jwk: DevicePublicJwk, payload: string, sigB64Url: string): Promise<boolean>`.
  - `DeviceCheck`: verifies the signature when the route has `@RequiresDevice()`, when the token is device-bound (`principal.deviceId`), or whenever device headers are present; sets `req.device = { id, registerId }`. Constants `MAX_CLOCK_SKEW_SEC = 120`, `NONCE_TTL_SEC = 300`.
  - Guard order after this task: realm → tenant status → auth → device → module → permission.
  - `DevicesService.createEnrollment(tenant, ctx, registerId) → { code, expiresAt, registerId }`, `.enroll(tenant, input, meta) → { deviceId, registerId }`, `.list(tenant)`, `.revoke(tenant, ctx, deviceId): Promise<void>`.
  - Routes: `POST /api/devices/enrollments` (`device.enroll`), `POST /api/devices/enroll` (public), `GET /api/devices` (`device.enroll`), `POST /api/devices/:id/revoke` (`device.revoke`, 204), `GET /api/devices/whoami` (public, device-signed).
  - Test helpers: `createDeviceKeys()`, `signedHeaders(device, method, path, body?, opts?)`, `enrollTestDevice(tenantId, registerId, enrolledById): Promise<TestDevice>`.

- [ ] **Step 1: Test helper**

`backend/test/helpers/device.ts`:
```ts
import { randomUUID, webcrypto } from 'node:crypto';
import { buildSigningPayload } from '@pos/shared';
import { sha256Hex } from '../../src/common/crypto/hash.js';
import { ownerDb } from './db.js';

type Key = webcrypto.CryptoKey;
export interface TestDevice {
  id: string;
  privateKey: Key;
  publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

export async function createDeviceKeys() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, publicKeyJwk: { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! } };
}

/** Headers a till would send. `body` must be exactly what supertest will .send(). */
export async function signedHeaders(
  device: { id: string; privateKey: Key },
  method: string,
  path: string,
  body?: unknown,
  opts: { ts?: number; nonce?: string } = {},
): Promise<Record<string, string>> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomUUID();
  const payload = buildSigningPayload(method, path, sha256Hex(raw), ts, nonce);
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, new TextEncoder().encode(payload));
  return { 'x-device-id': device.id, 'x-device-ts': ts, 'x-device-nonce': nonce, 'x-device-sig': Buffer.from(sig).toString('base64url') };
}

/** Enrols directly in the DB, skipping the enrollment-code flow. */
export async function enrollTestDevice(tenantId: string, registerId: string, enrolledById: string): Promise<TestDevice> {
  const keys = await createDeviceKeys();
  const device = await ownerDb().device.create({
    data: { tenantId, registerId, name: 'Test till', publicKeyJwk: keys.publicKeyJwk, enrolledById },
  });
  return { id: device.id, ...keys };
}
```

- [ ] **Step 2: Write the failing tests**

`backend/test/devices.e2e.spec.ts`:
```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { createDeviceKeys, enrollTestDevice, signedHeaders } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';
const WHOAMI = '/api/devices/whoami';

describe('devices', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;
  let registerId: string;
  let managerId: string;
  let managerToken: string;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme', maxDevices: 2 })).id;
    const store = await createStore(tenantId);
    registerId = (await createRegister(tenantId, store.id)).id;
    managerId = (await createUser(tenantId, { email: 'mgr@acme.lk', password: PW, permissions: ['device.enroll', 'device.revoke'] })).user.id;
    managerToken = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
  });

  async function enrollViaApi() {
    const created = await http().post('/api/devices/enrollments').set('Host', host).set(bearer(managerToken)).send({ registerId }).expect(201);
    expect(created.body.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    const keys = await createDeviceKeys();
    const enrolled = await http()
      .post('/api/devices/enroll')
      .set('Host', host)
      .send({ code: created.body.code, name: 'Front till', publicKeyJwk: keys.publicKeyJwk })
      .expect(201);
    return { code: created.body.code as string, device: { id: enrolled.body.deviceId as string, ...keys } };
  }

  it('enrols a device with a one-time code, then accepts its signed requests', async () => {
    const { device } = await enrollViaApi();
    const res = await http().get(WHOAMI).set('Host', host).set(await signedHeaders(device, 'GET', WHOAMI)).expect(200);
    expect(res.body).toEqual({ id: device.id, registerId });
    expect(await ownerDb().auditEvent.count({ where: { action: 'device.enrolled' } })).toBe(1);
  });

  it('enrollment codes are single use', async () => {
    const { code } = await enrollViaApi();
    const keys = await createDeviceKeys();
    await http().post('/api/devices/enroll').set('Host', host).send({ code, name: 'Second', publicKeyJwk: keys.publicKeyJwk }).expect(401);
  });

  it('expired enrollment codes are refused', async () => {
    const created = await http().post('/api/devices/enrollments').set('Host', host).set(bearer(managerToken)).send({ registerId }).expect(201);
    await ownerDb().deviceEnrollment.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const keys = await createDeviceKeys();
    await http().post('/api/devices/enroll').set('Host', host).send({ code: created.body.code, name: 'x', publicKeyJwk: keys.publicKeyJwk }).expect(401);
  });

  it('rejects a public key that is not a valid P-256 point', async () => {
    const created = await http().post('/api/devices/enrollments').set('Host', host).set(bearer(managerToken)).send({ registerId }).expect(201);
    const bogus = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) };
    const res = await http().post('/api/devices/enroll').set('Host', host).send({ code: created.body.code, name: 'x', publicKeyJwk: bogus }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an enrollment for a register that does not exist in this tenant', async () => {
    const other = await createTenant({ slug: 'other' });
    const otherRegister = await createRegister(other.id, (await createStore(other.id)).id);
    await http().post('/api/devices/enrollments').set('Host', host).set(bearer(managerToken)).send({ registerId: otherRegister.id }).expect(404);
  });

  it('enforces the plan device limit', async () => {
    await enrollTestDevice(tenantId, registerId, managerId);
    await enrollTestDevice(tenantId, registerId, managerId);
    const res = await http().post('/api/devices/enrollments').set('Host', host).set(bearer(managerToken)).send({ registerId }).expect(403);
    expect(res.body.code).toBe('PLAN_LIMIT_REACHED');
  });

  describe('signature verification', () => {
    it('refuses unsigned requests', async () => {
      const res = await http().get(WHOAMI).set('Host', host).expect(401);
      expect(res.body.code).toBe('DEVICE_SIGNATURE_INVALID');
    });

    it('refuses a signature made for a different path', async () => {
      const device = await enrollTestDevice(tenantId, registerId, managerId);
      await http().get(`${WHOAMI}?x=1`).set('Host', host).set(await signedHeaders(device, 'GET', WHOAMI)).expect(401);
    });

    it('refuses a replayed nonce', async () => {
      const device = await enrollTestDevice(tenantId, registerId, managerId);
      const headers = await signedHeaders(device, 'GET', WHOAMI);
      await http().get(WHOAMI).set('Host', host).set(headers).expect(200);
      await http().get(WHOAMI).set('Host', host).set(headers).expect(401);
    });

    it('refuses stale timestamps', async () => {
      const device = await enrollTestDevice(tenantId, registerId, managerId);
      const headers = await signedHeaders(device, 'GET', WHOAMI, undefined, { ts: Math.floor(Date.now() / 1000) - 300 });
      await http().get(WHOAMI).set('Host', host).set(headers).expect(401);
    });

    it('refuses a signature from another key', async () => {
      const device = await enrollTestDevice(tenantId, registerId, managerId);
      const impostor = await createDeviceKeys();
      await http().get(WHOAMI).set('Host', host).set(await signedHeaders({ id: device.id, privateKey: impostor.privateKey }, 'GET', WHOAMI)).expect(401);
    });

    it("refuses another tenant's device", async () => {
      await createTenant({ slug: 'other' });
      const device = await enrollTestDevice(tenantId, registerId, managerId);
      await http().get(WHOAMI).set('Host', hostFor('other')).set(await signedHeaders(device, 'GET', WHOAMI)).expect(401);
    });
  });

  it('a revoked device is refused immediately', async () => {
    const device = await enrollTestDevice(tenantId, registerId, managerId);
    await http().post(`/api/devices/${device.id}/revoke`).set('Host', host).set(bearer(managerToken)).expect(204);
    const res = await http().get(WHOAMI).set('Host', host).set(await signedHeaders(device, 'GET', WHOAMI)).expect(401);
    expect(res.body.code).toBe('DEVICE_REVOKED');
  });

  it('lists devices for managers', async () => {
    const device = await enrollTestDevice(tenantId, registerId, managerId);
    const res = await http().get('/api/devices').set('Host', host).set(bearer(managerToken)).expect(200);
    expect(res.body).toEqual([expect.objectContaining({ id: device.id, registerId, revokedAt: null })]);
    expect(res.body[0].publicKeyJwk).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w backend -- test/devices.e2e.spec.ts`
Expected: FAIL — `/api/devices/enrollments` 404.

- [ ] **Step 4: Implement**

`backend/src/security/device-signature.ts`:
```ts
import { webcrypto } from 'node:crypto';

export interface DevicePublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** Throws if the JWK is not a valid P-256 public point. */
export function importDeviceKey(jwk: DevicePublicJwk) {
  return webcrypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

export async function verifyDeviceSignature(jwk: DevicePublicJwk, payload: string, sigB64Url: string): Promise<boolean> {
  try {
    const key = await importDeviceKey(jwk);
    return await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Buffer.from(sigB64Url, 'base64url'),
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}
```

`backend/src/modules/access/checks/device.check.ts`:
```ts
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { buildSigningPayload, DEVICE_HEADERS } from '@pos/shared';
import { sha256Hex } from '../../../common/crypto/hash.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import { TenantDb } from '../../../infra/tenant-db.service.js';
import { type DevicePublicJwk, verifyDeviceSignature } from '../../../security/device-signature.js';
import { NonceStore } from '../../../security/nonce-store.js';
import type { AccessCheck } from '../access.guard.js';
import { DEVICE_KEY, routeMeta } from '../decorators.js';

export const MAX_CLOCK_SKEW_SEC = 120;
export const NONCE_TTL_SEC = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9-]{8,64}$/;
const invalid = (message = 'Invalid device signature') => new AppError('DEVICE_SIGNATURE_INVALID', 401, message);

@Injectable()
export class DeviceCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantDb: TenantDb,
    private readonly nonces: NonceStore,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    const id = req.header(DEVICE_HEADERS.id);
    const required = routeMeta<boolean>(this.reflector, DEVICE_KEY, ctx) === true;
    if (!required && !req.principal?.deviceId && !id) return;

    const ts = req.header(DEVICE_HEADERS.ts);
    const nonce = req.header(DEVICE_HEADERS.nonce);
    const sig = req.header(DEVICE_HEADERS.sig);
    if (!id || !ts || !nonce || !sig || !UUID.test(id) || !/^\d{1,12}$/.test(ts) || !NONCE.test(nonce)) throw invalid();
    if (req.principal?.deviceId && req.principal.deviceId !== id) throw invalid('Session is bound to a different device');
    if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_CLOCK_SKEW_SEC) throw invalid('Device clock skew too large');
    if (!req.tenant) throw invalid();

    const device = await this.tenantDb.run(req.tenant.id, (tx) => tx.device.findUnique({ where: { id } }));
    if (!device) throw invalid();
    if (device.revokedAt) throw new AppError('DEVICE_REVOKED', 401, 'This device has been revoked');

    const payload = buildSigningPayload(req.method, req.originalUrl, sha256Hex(req.rawBody ?? Buffer.alloc(0)), ts, nonce);
    if (!(await verifyDeviceSignature(device.publicKeyJwk as unknown as DevicePublicJwk, payload, sig))) throw invalid();
    // Claim the nonce only after the signature verifies, so forged requests cannot burn nonces.
    if (!(await this.nonces.claim(`${id}:${nonce}`, NONCE_TTL_SEC))) throw invalid('Replayed request');

    req.device = { id: device.id, registerId: device.registerId };
  }
}
```

`backend/src/modules/identity/devices.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { CreateEnrollmentSchema, EnrollDeviceSchema } from '@pos/shared';
import type { z } from 'zod';
import { randomCode, sha256Hex } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { RateLimiter } from '../../infra/rate-limiter.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { importDeviceKey } from '../../security/device-signature.js';
import { RevocationStore } from '../../security/revocation.store.js';
import { PlanLimitsService } from '../access/plan-limits.service.js';
import type { auditContext, RequestMeta } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { ACCESS_TTL_SEC, SessionService } from './session.service.js';

const ENROLLMENT_TTL_MS = 10 * 60_000;
type Ctx = ReturnType<typeof auditContext>;

@Injectable()
export class DevicesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly limits: PlanLimitsService,
    private readonly sessions: SessionService,
    private readonly revocations: RevocationStore,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
  ) {}

  createEnrollment(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof CreateEnrollmentSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const register = await tx.register.findUnique({ where: { id: input.registerId } });
      if (!register) throw AppError.notFound('Register not found');
      await this.limits.assertCanAdd(tx, tenant, 'devices');
      const code = randomCode(8);
      const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
      await tx.deviceEnrollment.create({
        data: { tenantId: tenant.id, registerId: register.id, codeHash: sha256Hex(code), createdById: ctx.actorUserId!, expiresAt },
      });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'device.enrollment_created', entityType: 'Register', entityId: register.id });
      return { code, expiresAt, registerId: register.id };
    });
  }

  async enroll(tenant: TenantContext, input: z.infer<typeof EnrollDeviceSchema>, meta: RequestMeta) {
    const allowed =
      (await this.limiter.consume(`enroll-ip:${meta.ip}`, 10, 900)) && (await this.limiter.consume(`enroll-tenant:${tenant.id}`, 30, 900));
    if (!allowed) throw AppError.rateLimited();
    try {
      await importDeviceKey(input.publicKeyJwk);
    } catch {
      throw AppError.validation([{ path: 'publicKeyJwk', message: 'Not a valid P-256 public key' }]);
    }

    return this.tenantDb.run(tenant.id, async (tx) => {
      const now = new Date();
      const enrollment = await tx.deviceEnrollment.findFirst({ where: { codeHash: sha256Hex(input.code), usedAt: null, expiresAt: { gt: now } } });
      if (!enrollment) throw AppError.unauthenticated('Invalid or expired enrollment code');
      const claimed = await tx.deviceEnrollment.updateMany({ where: { id: enrollment.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count !== 1) throw AppError.unauthenticated('Invalid or expired enrollment code');
      await this.limits.assertCanAdd(tx, tenant, 'devices');

      const device = await tx.device.create({
        data: {
          tenantId: tenant.id,
          registerId: enrollment.registerId,
          name: input.name,
          publicKeyJwk: input.publicKeyJwk,
          enrolledById: enrollment.createdById,
        },
      });
      await this.audit.record(tx, tenant.id, {
        ...meta,
        action: 'device.enrolled',
        entityType: 'Device',
        entityId: device.id,
        deviceId: device.id,
        actorUserId: enrollment.createdById,
        after: { name: device.name, registerId: device.registerId },
      });
      return { deviceId: device.id, registerId: device.registerId };
    });
  }

  list(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.device.findMany({
        orderBy: { enrolledAt: 'asc' },
        select: { id: true, name: true, registerId: true, enrolledAt: true, enrolledById: true, revokedAt: true },
      }),
    );
  }

  async revoke(tenant: TenantContext, ctx: Ctx, deviceId: string): Promise<void> {
    const familyIds = await this.tenantDb.run(tenant.id, async (tx) => {
      const device = await tx.device.findUnique({ where: { id: deviceId } });
      if (!device) throw AppError.notFound('Device not found');
      if (device.revokedAt) return [];
      await tx.device.update({ where: { id: deviceId }, data: { revokedAt: new Date() } });
      const ids = await this.sessions.revokeWhere(tx, { deviceId });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'device.revoked', entityType: 'Device', entityId: deviceId });
      return ids;
    });
    await Promise.all(familyIds.map((id) => this.revocations.markRevoked(id, ACCESS_TTL_SEC)));
  }
}
```

`backend/src/modules/identity/devices.controller.ts`:
```ts
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { CreateEnrollmentSchema, EnrollDeviceSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Public, RequiresDevice, RequiresPermission } from '../access/decorators.js';
import { auditContext, requestMeta } from '../audit/audit-context.js';
import { DevicesService } from './devices.service.js';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @RequiresPermission('device.enroll')
  @Post('enrollments')
  createEnrollment(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateEnrollmentSchema)) body: z.infer<typeof CreateEnrollmentSchema>) {
    return this.devices.createEnrollment(req.tenant!, auditContext(req), body);
  }

  @Public()
  @Post('enroll')
  enroll(@Req() req: RequestWithContext, @Body(new ZodPipe(EnrollDeviceSchema)) body: z.infer<typeof EnrollDeviceSchema>) {
    return this.devices.enroll(req.tenant!, body, requestMeta(req));
  }

  @RequiresPermission('device.enroll')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.devices.list(req.tenant!);
  }

  @RequiresPermission('device.revoke')
  @Post(':id/revoke')
  @HttpCode(204)
  async revoke(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.devices.revoke(req.tenant!, auditContext(req), id);
  }

  @Public()
  @RequiresDevice()
  @Get('whoami')
  whoami(@Req() req: RequestWithContext) {
    return req.device;
  }
}
```

`backend/src/modules/identity/identity.module.ts`: add `DevicesController` to `controllers` and `DevicesService` to `providers`.

`backend/src/modules/access/access.guard.ts` (replace the constructor):
```ts
import { DeviceCheck } from './checks/device.check.js';
// …
  constructor(
    realm: RealmCheck,
    tenantStatus: TenantStatusCheck,
    auth: AuthCheck,
    device: DeviceCheck,
    modules: ModuleCheck,
    permissions: PermissionCheck,
  ) {
    this.steps = [realm, tenantStatus, auth, device, modules, permissions];
  }
```

`backend/src/modules/access/access.module.ts`: add `DeviceCheck` to `providers` (import from `./checks/device.check.js`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/security/device-signature.ts backend/src/modules backend/test
git commit -m "feat(devices): one-time enrollment codes, ECDSA request signing with nonce + skew checks, revocation"
```

---

### Task 12: Cashier PIN login and manager step-up

**Files:**
- Create: `backend/src/modules/identity/step-up.service.ts`, `backend/src/modules/access/checks/step-up.check.ts`
- Modify: `backend/src/modules/identity/auth.service.ts` (add `pinLogin`), `backend/src/modules/identity/auth.controller.ts` (add `pin`, `step-up` routes), `backend/src/modules/identity/identity.module.ts`, `backend/src/modules/access/access.guard.ts`, `backend/src/modules/access/access.module.ts`
- Test: `backend/test/pin-stepup.e2e.spec.ts`

**Interfaces:**
- Consumes: `PinLoginSchema`, `StepUpSchema`; `LockoutService`, `SessionService`, `CapabilitiesService`, `TokenService`, `NonceStore`.
- Produces:
  - `AuthService.pinLogin(tenant, device: { id: string }, input: { userId, pin }, meta): Promise<IssuedSession>`.
  - `STEP_UP_TTL_SEC = 120`; `interface StepUpClaims { tid: string; did: string; act: Permission; req: string }`; `StepUpService.approve(tenant, device, requesterUserId, input, ctx): Promise<{ stepUpToken: string; expiresIn: number }>`.
  - `StepUpCheck`: for routes with `@RequiresStepUp(action)`, requires header `x-step-up-token` whose claims match action, tenant, device and requester; single use.
  - Routes: `POST /api/auth/pin` (public, device-signed), `POST /api/auth/step-up` (authed, device-signed).
  - Guard order after this task (final): realm → tenant status → auth → device → module → permission → step-up.

- [ ] **Step 1: Write the failing tests**

`backend/test/pin-stepup.e2e.spec.ts`:
```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { resetDb } from './helpers/db.js';
import { enrollTestDevice, signedHeaders, type TestDevice } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword, refreshCookie } from './helpers/http.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('PIN login and step-up', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;
  let registerId: string;
  let cashierId: string;
  let managerId: string;
  let device: TestDevice;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme' })).id;
    registerId = (await createRegister(tenantId, (await createStore(tenantId)).id)).id;
    cashierId = (await createUser(tenantId, { name: 'Cashier', pin: '1234', permissions: ['sale.create'] })).user.id;
    managerId = (
      await createUser(tenantId, {
        name: 'Manager', email: 'mgr@acme.lk', password: PW, pin: '9876',
        permissions: ['sale.create', 'sale.refund', 'device.revoke'],
      })
    ).user.id;
    device = await enrollTestDevice(tenantId, registerId, managerId);
  });

  async function pinLogin(userId = cashierId, pin = '1234', d: TestDevice = device) {
    const body = { userId, pin };
    return http().post('/api/auth/pin').set('Host', host).set(await signedHeaders(d, 'POST', '/api/auth/pin', body)).send(body);
  }

  async function deviceSale(token: string, d: TestDevice = device) {
    return http().post('/api/probe/device-sale').set('Host', host).set(bearer(token)).set(await signedHeaders(d, 'POST', '/api/probe/device-sale'));
  }

  it('logs a cashier in with a PIN on an enrolled device; the session is device-bound', async () => {
    const res = await pinLogin();
    expect(res.status).toBe(200);
    const ok = await deviceSale(res.body.accessToken);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ device: { id: device.id, registerId }, principal: { userId: cashierId, deviceId: device.id } });
    // Same token without a signature, or signed by another device, is refused.
    await http().post('/api/probe/device-sale').set('Host', host).set(bearer(res.body.accessToken)).expect(401);
    const other = await enrollTestDevice(tenantId, registerId, managerId);
    expect((await deviceSale(res.body.accessToken, other)).status).toBe(401);
  });

  it('refuses PIN login without a device signature', async () => {
    const res = await http().post('/api/auth/pin').set('Host', host).send({ userId: cashierId, pin: '1234' }).expect(401);
    expect(res.body.code).toBe('DEVICE_SIGNATURE_INVALID');
  });

  it('locks PIN login after 5 wrong PINs', async () => {
    for (let i = 0; i < 5; i++) expect((await pinLogin(cashierId, '0000')).status).toBe(401);
    const res = await pinLogin();
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('device-bound refresh requires the same device', async () => {
    const login = await pinLogin();
    const rt = refreshCookie(login)!;
    await http().post('/api/auth/refresh').set('Host', host).set('Cookie', `pos_rt=${rt}`).expect(401);
    const login2 = await pinLogin();
    const rt2 = refreshCookie(login2)!;
    await http()
      .post('/api/auth/refresh')
      .set('Host', host)
      .set('Cookie', `pos_rt=${rt2}`)
      .set(await signedHeaders(device, 'POST', '/api/auth/refresh'))
      .expect(200);
  });

  it('revoking the device ends its sessions', async () => {
    const login = await pinLogin();
    const mgrToken = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
    await http().post(`/api/devices/${device.id}/revoke`).set('Host', host).set(bearer(mgrToken)).expect(204);
    const res = await deviceSale(login.body.accessToken);
    expect(res.status).toBe(401);
  });

  describe('step-up', () => {
    async function refund(token: string, stepUpToken?: string) {
      const req = http().post('/api/probe/refund').set('Host', host).set(bearer(token)).set(await signedHeaders(device, 'POST', '/api/probe/refund'));
      return stepUpToken ? req.set('x-step-up-token', stepUpToken) : req;
    }
    async function approve(token: string, approverUserId: string, pin: string, action = 'sale.refund', d: TestDevice = device) {
      const body = { approverUserId, pin, action };
      return http().post('/api/auth/step-up').set('Host', host).set(bearer(token)).set(await signedHeaders(d, 'POST', '/api/auth/step-up', body)).send(body);
    }

    it('requires a manager approval for the action, usable once', async () => {
      const cashier = (await pinLogin()).body.accessToken as string;
      const denied = await refund(cashier);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'STEP_UP_REQUIRED', details: { action: 'sale.refund' } });

      const granted = await approve(cashier, managerId, '9876');
      expect(granted.status).toBe(200);
      expect(granted.body.expiresIn).toBe(120);
      expect((await refund(cashier, granted.body.stepUpToken)).status).toBe(200);
      expect((await refund(cashier, granted.body.stepUpToken)).status).toBe(403);
    });

    it('refuses an approver without the permission', async () => {
      const cashier = (await pinLogin()).body.accessToken as string;
      const res = await approve(cashier, cashierId, '1234');
      expect(res.status).toBe(403);
    });

    it('refuses a wrong approver PIN', async () => {
      const cashier = (await pinLogin()).body.accessToken as string;
      expect((await approve(cashier, managerId, '0000')).status).toBe(401);
    });

    it('an approval for another action does not unlock this one', async () => {
      const cashier = (await pinLogin()).body.accessToken as string;
      const granted = await approve(cashier, managerId, '9876', 'sale.create');
      expect((await refund(cashier, granted.body.stepUpToken)).status).toBe(403);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/pin-stepup.e2e.spec.ts`
Expected: FAIL — `/api/auth/pin` 404.

- [ ] **Step 3: Implement**

Add to `AuthService` (`backend/src/modules/identity/auth.service.ts`), importing `PinLoginSchema` as a type alongside the others:
```ts
  async pinLogin(
    tenant: TenantContext,
    device: { id: string },
    input: z.infer<typeof PinLoginSchema>,
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    if (!(await this.limiter.consume(`pin-dev:${device.id}`, 30, 900))) throw AppError.rateLimited();
    const user = await this.tenantDb.run(tenant.id, (tx) => tx.user.findFirst({ where: { id: input.userId, status: 'ACTIVE' } }));
    if (user) this.lockout.assertNotLocked(user.pinLockedUntil);
    const ok = await this.passwords.verify(user?.pinHash, input.pin);
    if (!user || !ok) {
      if (user) await this.lockout.recordFailure(tenant.id, user.id, 'pin', { ...meta, deviceId: device.id });
      throw AppError.unauthenticated('Invalid PIN');
    }
    return this.tenantDb.run(tenant.id, async (tx) => {
      await this.lockout.resetInTx(tx, user.id, 'pin');
      const session = await this.sessions.start(tx, { tenantId: tenant.id, userId: user.id, deviceId: device.id });
      await this.audit.record(tx, tenant.id, {
        ...meta,
        action: 'auth.pin_login',
        entityType: 'User',
        entityId: user.id,
        actorUserId: user.id,
        deviceId: device.id,
      });
      return session;
    });
  }
```

`backend/src/modules/identity/step-up.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { Permission, StepUpSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { RateLimiter } from '../../infra/rate-limiter.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { PasswordService } from '../../security/password.service.js';
import { TokenService } from '../../security/token.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { LockoutService } from './lockout.service.js';

export const STEP_UP_TTL_SEC = 120;

export interface StepUpClaims {
  tid: string;
  did: string;
  act: Permission;
  /** The user the approval was granted to. */
  req: string;
}

@Injectable()
export class StepUpService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly lockout: LockoutService,
    private readonly capabilities: CapabilitiesService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
  ) {}

  async approve(
    tenant: TenantContext,
    device: { id: string },
    requesterUserId: string,
    input: z.infer<typeof StepUpSchema>,
    ctx: ReturnType<typeof auditContext>,
  ): Promise<{ stepUpToken: string; expiresIn: number }> {
    if (!(await this.limiter.consume(`stepup-dev:${device.id}`, 20, 900))) throw AppError.rateLimited();
    const approver = await this.tenantDb.run(tenant.id, (tx) =>
      tx.user.findFirst({ where: { id: input.approverUserId, status: 'ACTIVE' } }),
    );
    if (approver) this.lockout.assertNotLocked(approver.pinLockedUntil);
    const ok = await this.passwords.verify(approver?.pinHash, input.pin);
    if (!approver || !ok) {
      if (approver) await this.lockout.recordFailure(tenant.id, approver.id, 'pin', ctx);
      throw AppError.unauthenticated('Invalid approver PIN');
    }
    const perms = await this.capabilities.permissionsFor(tenant.id, approver.id);
    if (!perms.has(input.action)) throw AppError.forbidden(`Approver lacks ${input.action}`);

    await this.tenantDb.run(tenant.id, async (tx) => {
      await this.lockout.resetInTx(tx, approver.id, 'pin');
      await this.audit.record(tx, tenant.id, {
        ...ctx,
        action: 'auth.step_up_granted',
        entityType: 'User',
        entityId: approver.id,
        after: { action: input.action, approverUserId: approver.id, requesterUserId },
      });
    });
    const stepUpToken = await this.tokens.sign(
      'step-up',
      { sub: approver.id, tid: tenant.id, did: device.id, act: input.action, req: requesterUserId },
      STEP_UP_TTL_SEC,
    );
    return { stepUpToken, expiresIn: STEP_UP_TTL_SEC };
  }
}
```

`backend/src/modules/access/checks/step-up.check.ts`:
```ts
import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@pos/shared';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import { NonceStore } from '../../../security/nonce-store.js';
import { TokenService } from '../../../security/token.service.js';
import type { StepUpClaims } from '../../identity/step-up.service.js';
import type { AccessCheck } from '../access.guard.js';
import { routeMeta, STEP_UP_KEY } from '../decorators.js';

@Injectable()
export class StepUpCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly nonces: NonceStore,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    const action = routeMeta<Permission>(this.reflector, STEP_UP_KEY, ctx);
    if (!action) return;
    const required = () => new AppError('STEP_UP_REQUIRED', 403, 'Manager approval required', { action });
    const token = req.header('x-step-up-token');
    if (!token) throw required();
    let claims: StepUpClaims & { jti: string };
    try {
      claims = await this.tokens.verify<StepUpClaims>(token, 'step-up');
    } catch {
      throw required();
    }
    const matches =
      claims.act === action && claims.tid === req.tenant?.id && claims.did === req.device?.id && claims.req === req.principal?.userId;
    if (!matches) throw required();
    if (!(await this.nonces.claim(`stepup:${claims.jti}`, 300))) throw required();
  }
}
```

`backend/src/modules/access/access.guard.ts` (replace the constructor; final version):
```ts
import { StepUpCheck } from './checks/step-up.check.js';
// …
  constructor(
    realm: RealmCheck,
    tenantStatus: TenantStatusCheck,
    auth: AuthCheck,
    device: DeviceCheck,
    modules: ModuleCheck,
    permissions: PermissionCheck,
    stepUp: StepUpCheck,
  ) {
    this.steps = [realm, tenantStatus, auth, device, modules, permissions, stepUp];
  }
```

`backend/src/modules/access/access.module.ts`: add `StepUpCheck` to `providers`.

Add to `AuthController` (`backend/src/modules/identity/auth.controller.ts`), with imports `PinLoginSchema`, `StepUpSchema`, `RequiresDevice`, `auditContext`, `StepUpService`, and inject `private readonly stepUp: StepUpService` in the constructor:
```ts
  @Public()
  @RequiresDevice()
  @Post('pin')
  @HttpCode(200)
  async pin(
    @Req() req: RequestWithContext,
    @Body(new ZodPipe(PinLoginSchema)) body: z.infer<typeof PinLoginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.pinLogin(req.tenant!, req.device!, body, requestMeta(req));
    setRefreshCookie(res, session.refreshToken, TENANT_COOKIE_PATH);
    return { status: 'ok', accessToken: session.accessToken };
  }

  @RequiresDevice()
  @Post('step-up')
  @HttpCode(200)
  stepUpApprove(@Req() req: RequestWithContext, @Body(new ZodPipe(StepUpSchema)) body: z.infer<typeof StepUpSchema>) {
    return this.stepUp.approve(req.tenant!, req.device!, req.principal!.userId, body, auditContext(req));
  }
```

`backend/src/modules/identity/identity.module.ts`: add `StepUpService` to `providers`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules backend/test/pin-stepup.e2e.spec.ts
git commit -m "feat(identity): device-bound PIN login and single-use manager step-up approvals"
```

---

### Task 13: Super-admin realm — login, MFA, sessions, bootstrap

**Files:**
- Create: `backend/src/modules/platform/platform-session.service.ts`, `backend/src/modules/platform/platform-auth.service.ts`, `backend/src/modules/platform/platform-auth.controller.ts`, `backend/src/modules/platform/platform.module.ts`
- Modify: `backend/src/modules/audit/audit-context.ts` (add `platformAuditContext`), `backend/src/app.module.ts`
- Create: `backend/scripts/create-super-admin.ts`
- Modify: `backend/test/helpers/fixtures.ts` (add `createSuperAdmin`), `backend/test/helpers/http.ts` (add `loginSuperAdmin`)
- Test: `backend/test/platform-auth.e2e.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `PasswordService`, `TokenService`, `RevocationStore`, `Aead`, `RateLimiter`, `AuditService.recordPlatform`, `verifyTotp`, `otpauthUrl`, `cookies.ts` (`PLATFORM_COOKIE_PATH`).
- Produces:
  - `platformAuditContext(req): Pick<PlatformAuditEntry, 'actorId' | 'ip' | 'userAgent' | 'correlationId'>`.
  - `PlatformSessionService.start(tx, superAdminId)`, `.rotate(refreshToken)`, `.revoke(familyId)` → same shapes as `SessionService` but platform tables and audience `platform`.
  - `PlatformAuthService.login`, `.verifyMfa`, `.setupPassword` (MFA always required).
  - Routes (admin host only): `POST /api/platform/auth/login`, `/mfa/verify`, `/setup-password` (204), `/refresh`, `/logout` (204, authed).
  - Script `npm run platform:create-admin -w backend -- --email you@example.com --name "Your Name"`.
  - Test helpers: `createSuperAdmin({ email, password?, totpSecret?, setupCode? })`, `loginSuperAdmin(app, email, password, secret): Promise<string>`.

- [ ] **Step 1: Fixtures and helpers**

Append to `backend/test/helpers/fixtures.ts`:
```ts
export async function createSuperAdmin(input: { email: string; password?: string; totpSecret?: Buffer; setupCode?: string }) {
  return ownerDb().superAdmin.create({
    data: {
      email: input.email.toLowerCase(),
      name: 'Platform Admin',
      passwordHash: input.password ? await passwords.hash(input.password) : null,
      totpSecretEnc: input.totpSecret ? testAead().encrypt(input.totpSecret.toString('base64')) : null,
      setupTokenHash: input.setupCode ? sha256Hex(input.setupCode) : null,
      setupTokenExpiresAt: input.setupCode ? new Date(Date.now() + 3_600_000) : null,
    },
  });
}
```

Append to `backend/test/helpers/http.ts` (move the new `import` lines to the top of the file):
```ts
import { hotp, totpCounter } from '../../src/common/crypto/totp.js';
import { ADMIN_HOST } from './fixtures.js';

const lastCounter = new Map<string, number>();

/** Generates a fresh (never reused) TOTP code for this secret within the accepted window. */
export function nextTotp(secret: Buffer): string {
  const key = secret.toString('hex');
  const counter = Math.max(totpCounter(Date.now()), (lastCounter.get(key) ?? -1) + 1);
  lastCounter.set(key, counter);
  return hotp(secret, counter);
}

export async function loginSuperAdmin(app: NestExpressApplication, email: string, password: string, secret: Buffer): Promise<string> {
  const http = request(app.getHttpServer());
  const login = await http.post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email, password }).expect(200);
  const verified = await request(app.getHttpServer())
    .post('/api/platform/auth/mfa/verify')
    .set('Host', ADMIN_HOST)
    .send({ mfaToken: login.body.mfaToken, code: nextTotp(secret) })
    .expect(200);
  return verified.body.accessToken as string;
}
```

Note: `nextTotp` can issue at most two logins per 30 s for one secret (current and next step). Tests create a fresh super admin per test.

- [ ] **Step 2: Write the failing tests**

`backend/test/platform-auth.e2e.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode } from '../src/common/crypto/base32.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createSuperAdmin, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword, loginSuperAdmin, nextTotp, refreshCookie } from './helpers/http.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('super-admin authentication', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController] });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
  });

  it('bootstraps: setup code → password → mandatory TOTP enrolment → platform token', async () => {
    await createSuperAdmin({ email: 'root@pos.lk', setupCode: 'platform-setup-code-123' });
    await http().post('/api/platform/auth/setup-password').set('Host', ADMIN_HOST).send({ code: 'platform-setup-code-123', password: PW }).expect(204);
    const login = await http().post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email: 'root@pos.lk', password: PW }).expect(200);
    expect(login.body.status).toBe('mfa_setup_required');
    const secret = base32Decode(login.body.secret);
    const verified = await http().post('/api/platform/auth/mfa/verify').set('Host', ADMIN_HOST).send({ mfaToken: login.body.mfaToken, code: nextTotp(secret) }).expect(200);
    const me = await http().get('/api/probe/platform-authed').set('Host', ADMIN_HOST).set(bearer(verified.body.accessToken)).expect(200);
    expect(me.body.realm).toBe('platform');
    const again = await http().post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email: 'root@pos.lk', password: PW }).expect(200);
    expect(again.body.status).toBe('mfa_required');
  });

  it('platform auth routes do not exist on tenant hosts', async () => {
    await createTenant({ slug: 'acme' });
    await http().post('/api/platform/auth/login').set('Host', hostFor('acme')).send({ email: 'root@pos.lk', password: PW }).expect(404);
  });

  it('keeps the realms apart: tokens only work on their own audience', async () => {
    const t = await createTenant({ slug: 'acme' });
    await createUser(t.id, { email: 'a@acme.lk', password: PW });
    const tenantToken = await loginPassword(app, 'acme', 'a@acme.lk', PW);
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret });
    const platformToken = await loginSuperAdmin(app, 'root@pos.lk', PW, secret);

    await http().get('/api/probe/platform-authed').set('Host', ADMIN_HOST).set(bearer(tenantToken)).expect(401);
    await http().get('/api/probe/authed').set('Host', hostFor('acme')).set(bearer(platformToken)).expect(401);
  });

  it('rejects a tenant MFA token at the platform verify endpoint', async () => {
    const t = await createTenant({ slug: 'acme' });
    const secret = randomBytes(20);
    await createUser(t.id, { email: 'mgr@acme.lk', password: PW, totpSecret: secret });
    const login = await http().post('/api/auth/login').set('Host', hostFor('acme')).send({ email: 'mgr@acme.lk', password: PW }).expect(200);
    await http().post('/api/platform/auth/mfa/verify').set('Host', ADMIN_HOST).send({ mfaToken: login.body.mfaToken, code: nextTotp(secret) }).expect(401);
  });

  it('locks a super admin after 5 failed passwords', async () => {
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: randomBytes(20) });
    for (let i = 0; i < 5; i++) await http().post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email: 'root@pos.lk', password: 'bad' }).expect(401);
    await http().post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email: 'root@pos.lk', password: PW }).expect(423);
    expect(await ownerDb().platformAuditEvent.count({ where: { action: 'platform.auth.password_failed' } })).toBe(5);
  });

  it('rotates platform refresh tokens and detects reuse', async () => {
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret });
    const login = await http().post('/api/platform/auth/login').set('Host', ADMIN_HOST).send({ email: 'root@pos.lk', password: PW });
    const verified = await http().post('/api/platform/auth/mfa/verify').set('Host', ADMIN_HOST).send({ mfaToken: login.body.mfaToken, code: nextTotp(secret) });
    const cookie = (verified.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('pos_rt='))!;
    expect(cookie).toMatch(/Path=\/api\/platform\/auth/);
    const rt1 = refreshCookie(verified)!;
    const r2 = await http().post('/api/platform/auth/refresh').set('Host', ADMIN_HOST).set('Cookie', `pos_rt=${rt1}`).expect(200);
    await http().post('/api/platform/auth/refresh').set('Host', ADMIN_HOST).set('Cookie', `pos_rt=${rt1}`).expect(401);
    await http().post('/api/platform/auth/refresh').set('Host', ADMIN_HOST).set('Cookie', `pos_rt=${refreshCookie(r2)}`).expect(401);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w backend -- test/platform-auth.e2e.spec.ts`
Expected: FAIL — `/api/platform/auth/*` 404.

- [ ] **Step 4: Implement**

Append to `backend/src/modules/audit/audit-context.ts` (merge the `import type` into the existing import from `./audit.service.js`):
```ts
import type { PlatformAuditEntry } from './audit.service.js';

export function platformAuditContext(req: RequestWithContext): Pick<PlatformAuditEntry, 'actorId' | 'ip' | 'userAgent' | 'correlationId'> {
  return { actorId: req.principal?.realm === 'platform' ? req.principal.userId : null, ...requestMeta(req) };
}
```

`backend/src/modules/platform/platform-session.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { randomToken, sha256Hex } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { RevocationStore } from '../../security/revocation.store.js';
import { TokenService } from '../../security/token.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ACCESS_TTL_SEC, type IssuedSession, REFRESH_ABSOLUTE_MS, REFRESH_IDLE_MS } from '../identity/session.service.js';

@Injectable()
export class PlatformSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly revocations: RevocationStore,
    private readonly audit: AuditService,
  ) {}

  async start(tx: Tx, superAdminId: string): Promise<IssuedSession> {
    const family = await tx.platformRefreshFamily.create({
      data: { superAdminId, absoluteExpiresAt: new Date(Date.now() + REFRESH_ABSOLUTE_MS) },
    });
    return this.issue(tx, family.id, superAdminId);
  }

  private async issue(tx: Tx, familyId: string, superAdminId: string): Promise<IssuedSession> {
    const refreshToken = randomToken();
    await tx.platformRefreshToken.create({
      data: { familyId, tokenHash: sha256Hex(refreshToken), expiresAt: new Date(Date.now() + REFRESH_IDLE_MS) },
    });
    const accessToken = await this.tokens.sign('platform', { sub: superAdminId, sid: familyId }, ACCESS_TTL_SEC);
    return { accessToken, refreshToken, familyId };
  }

  async rotate(refreshToken: string): Promise<IssuedSession> {
    const now = new Date();
    const outcome = await this.prisma.$transaction(async (tx) => {
      const token = await tx.platformRefreshToken.findUnique({ where: { tokenHash: sha256Hex(refreshToken) }, include: { family: true } });
      if (!token || token.family.revokedAt || token.family.absoluteExpiresAt <= now || token.expiresAt <= now) {
        return { kind: 'invalid' as const };
      }
      const claimed = await tx.platformRefreshToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count === 0) {
        await tx.platformRefreshFamily.update({ where: { id: token.familyId }, data: { revokedAt: now } });
        await this.audit.recordPlatform(tx, {
          action: 'platform.auth.refresh_reuse',
          entityType: 'PlatformRefreshFamily',
          entityId: token.familyId,
          actorId: token.family.superAdminId,
        });
        return { kind: 'reuse' as const, familyId: token.familyId };
      }
      return { kind: 'ok' as const, session: await this.issue(tx, token.familyId, token.family.superAdminId) };
    });
    if (outcome.kind === 'reuse') await this.revocations.markRevoked(outcome.familyId, ACCESS_TTL_SEC);
    if (outcome.kind !== 'ok') throw AppError.unauthenticated('Session expired');
    return outcome.session;
  }

  async revoke(familyId: string): Promise<void> {
    await this.prisma.platformRefreshFamily.updateMany({ where: { id: familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.revocations.markRevoked(familyId, ACCESS_TTL_SEC);
  }
}
```

`backend/src/modules/platform/platform-auth.service.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { LoginSchema, MfaVerifySchema, SetupPasswordSchema } from '@pos/shared';
import type { z } from 'zod';
import { Aead } from '../../common/crypto/aead.js';
import { base32Encode } from '../../common/crypto/base32.js';
import { sha256Hex } from '../../common/crypto/hash.js';
import { otpauthUrl, verifyTotp } from '../../common/crypto/totp.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { RateLimiter } from '../../infra/rate-limiter.js';
import { PasswordService } from '../../security/password.service.js';
import { TokenService } from '../../security/token.service.js';
import type { RequestMeta } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import type { IssuedSession } from '../identity/session.service.js';
import { LOCK_MS, MAX_FAILURES } from '../identity/lockout.service.js';
import { PlatformSessionService } from './platform-session.service.js';

type PlatformLoginResult =
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_setup_required'; mfaToken: string; otpauthUrl: string; secret: string };

interface PlatformMfaClaims {
  realm: 'platform';
  purpose: 'verify' | 'setup';
  sec?: string;
}

@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: PlatformSessionService,
    private readonly limiter: RateLimiter,
    private readonly audit: AuditService,
    private readonly aead: Aead,
  ) {}

  /** Super admins always complete TOTP; there is no password-only path. */
  async login(input: z.infer<typeof LoginSchema>, meta: RequestMeta): Promise<PlatformLoginResult> {
    const allowed =
      (await this.limiter.consume(`plogin:${input.email}`, 10, 900)) && (await this.limiter.consume(`plogin-ip:${meta.ip}`, 30, 900));
    if (!allowed) throw AppError.rateLimited();

    const admin = await this.prisma.superAdmin.findUnique({ where: { email: input.email } });
    if (admin?.lockedUntil && admin.lockedUntil > new Date()) throw new AppError('ACCOUNT_LOCKED', 423, 'Account temporarily locked');
    const ok = await this.passwords.verify(admin?.passwordHash, input.password);
    if (!admin || !ok) {
      if (admin) {
        await this.prisma.$transaction(async (tx) => {
          const updated = await tx.superAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: { increment: 1 } } });
          if (updated.failedLoginCount >= MAX_FAILURES) {
            await tx.superAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } });
          }
          await this.audit.recordPlatform(tx, { ...meta, action: 'platform.auth.password_failed', entityType: 'SuperAdmin', entityId: admin.id });
        });
      }
      throw AppError.unauthenticated('Invalid email or password');
    }
    await this.prisma.superAdmin.update({ where: { id: admin.id }, data: { failedLoginCount: 0, lockedUntil: null } });

    if (admin.totpSecretEnc) {
      return { status: 'mfa_required', mfaToken: await this.tokens.sign('mfa', { sub: admin.id, realm: 'platform', purpose: 'verify' }, 300) };
    }
    const secret = randomBytes(20);
    const mfaToken = await this.tokens.sign(
      'mfa',
      { sub: admin.id, realm: 'platform', purpose: 'setup', sec: this.aead.encrypt(secret.toString('base64')) },
      600,
    );
    return { status: 'mfa_setup_required', mfaToken, otpauthUrl: otpauthUrl('POS Platform', admin.email, secret), secret: base32Encode(secret) };
  }

  async verifyMfa(input: z.infer<typeof MfaVerifySchema>, meta: RequestMeta): Promise<IssuedSession> {
    const claims = await this.tokens.verify<PlatformMfaClaims>(input.mfaToken, 'mfa');
    if (claims.realm !== 'platform') throw AppError.unauthenticated('Invalid or expired token');
    if (!(await this.limiter.consume(`pmfa:${claims.sub}`, 5, 300))) throw AppError.rateLimited();

    return this.prisma.$transaction(async (tx) => {
      const admin = await tx.superAdmin.findUnique({ where: { id: claims.sub } });
      if (!admin) throw AppError.unauthenticated('Invalid or expired token');
      let secretB64: string;
      if (claims.purpose === 'setup') {
        if (admin.totpSecretEnc || !claims.sec) throw AppError.unauthenticated('MFA already enrolled; sign in again');
        secretB64 = this.aead.decrypt(claims.sec);
      } else {
        if (!admin.totpSecretEnc) throw AppError.unauthenticated('MFA not enrolled');
        secretB64 = this.aead.decrypt(admin.totpSecretEnc);
      }
      const counter = verifyTotp(Buffer.from(secretB64, 'base64'), input.code, Date.now(), admin.totpLastCounter);
      if (counter === null) throw AppError.unauthenticated('Invalid code');
      await tx.superAdmin.update({
        where: { id: admin.id },
        data: { totpLastCounter: counter, ...(claims.purpose === 'setup' ? { totpSecretEnc: this.aead.encrypt(secretB64) } : {}) },
      });
      const session = await this.sessions.start(tx, admin.id);
      await this.audit.recordPlatform(tx, {
        ...meta,
        action: claims.purpose === 'setup' ? 'platform.auth.mfa_enrolled' : 'platform.auth.login',
        entityType: 'SuperAdmin',
        entityId: admin.id,
        actorId: admin.id,
      });
      return session;
    });
  }

  async setupPassword(input: z.infer<typeof SetupPasswordSchema>, meta: RequestMeta): Promise<void> {
    if (!(await this.limiter.consume(`psetup-ip:${meta.ip}`, 10, 900))) throw AppError.rateLimited();
    const passwordHash = await this.passwords.hash(input.password);
    await this.prisma.$transaction(async (tx) => {
      const admin = await tx.superAdmin.findFirst({
        where: { setupTokenHash: sha256Hex(input.code), setupTokenExpiresAt: { gt: new Date() } },
      });
      if (!admin) throw AppError.unauthenticated('Invalid or expired setup code');
      await tx.superAdmin.update({ where: { id: admin.id }, data: { passwordHash, setupTokenHash: null, setupTokenExpiresAt: null } });
      await this.audit.recordPlatform(tx, { ...meta, action: 'platform.auth.password_set', entityType: 'SuperAdmin', entityId: admin.id, actorId: admin.id });
    });
  }
}
```

`backend/src/modules/platform/platform-auth.controller.ts`:
```ts
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { LoginSchema, MfaVerifySchema, SetupPasswordSchema } from '@pos/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Public, Realm } from '../access/decorators.js';
import { requestMeta } from '../audit/audit-context.js';
import { clearRefreshCookie, PLATFORM_COOKIE_PATH, REFRESH_COOKIE, setRefreshCookie } from '../identity/cookies.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformSessionService } from './platform-session.service.js';

@Realm('platform')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly sessions: PlatformSessionService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Req() req: RequestWithContext, @Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>) {
    return this.auth.login(body, requestMeta(req));
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async verify(
    @Req() req: RequestWithContext,
    @Body(new ZodPipe(MfaVerifySchema)) body: z.infer<typeof MfaVerifySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.verifyMfa(body, requestMeta(req));
    setRefreshCookie(res, session.refreshToken, PLATFORM_COOKIE_PATH);
    return { status: 'ok', accessToken: session.accessToken };
  }

  @Public()
  @Post('setup-password')
  @HttpCode(204)
  async setupPassword(@Req() req: RequestWithContext, @Body(new ZodPipe(SetupPasswordSchema)) body: z.infer<typeof SetupPasswordSchema>) {
    await this.auth.setupPassword(body, requestMeta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw AppError.unauthenticated('No session');
    const session = await this.sessions.rotate(token);
    setRefreshCookie(res, session.refreshToken, PLATFORM_COOKIE_PATH);
    return { accessToken: session.accessToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response) {
    if (req.principal?.sessionId) await this.sessions.revoke(req.principal.sessionId);
    clearRefreshCookie(res, PLATFORM_COOKIE_PATH);
  }
}
```

`backend/src/modules/platform/platform.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformSessionService } from './platform-session.service.js';

@Module({
  controllers: [PlatformAuthController],
  providers: [PlatformAuthService, PlatformSessionService],
})
export class PlatformModule {}
```

`backend/src/app.module.ts`: add `PlatformModule` to `imports` (after `BackofficeModule`) with `import { PlatformModule } from './modules/platform/platform.module.js';`.

`backend/scripts/create-super-admin.ts`:
```ts
import { parseArgs } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomToken, sha256Hex } from '../src/common/crypto/hash.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { AuditService } from '../src/modules/audit/audit.service.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email || !values.name) {
  console.error('Usage: npm run platform:create-admin -w backend -- --email you@example.com --name "Your Name"');
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_OWNER_URL! }) });
const code = randomToken(24);
const audit = new AuditService();

await prisma.$transaction(async (tx) => {
  const admin = await tx.superAdmin.create({
    data: {
      email: values.email!.toLowerCase(),
      name: values.name!,
      setupTokenHash: sha256Hex(code),
      setupTokenExpiresAt: new Date(Date.now() + 24 * 3_600_000),
    },
  });
  await audit.recordPlatform(tx, { action: 'platform.super_admin_bootstrapped', entityType: 'SuperAdmin', entityId: admin.id });
});
await prisma.$disconnect();

console.log('Super admin created.');
console.log('One-time setup code (valid 24 h, shown only once):');
console.log(code);
console.log(`Set the password with POST https://admin.${process.env.PLATFORM_DOMAIN}/api/platform/auth/setup-password`);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules backend/src/app.module.ts backend/scripts/create-super-admin.ts backend/test
git commit -m "feat(platform): super-admin realm with mandatory TOTP, rotating sessions, bootstrap script"
```

---

### Task 14: Business types and per-tenant module overrides

**Files:**
- Create: `backend/src/modules/platform/business-types.service.ts`, `backend/src/modules/platform/business-types.controller.ts`
- Create: `backend/src/modules/platform/tenant-modules.service.ts`, `backend/src/modules/platform/tenant-modules.controller.ts`
- Modify: `backend/src/modules/platform/platform.module.ts`
- Test: `backend/test/platform-config.e2e.spec.ts`

**Interfaces:**
- Consumes: `BusinessTypeSchema`, `ModuleOverrideSchema`, `applyOverrides`, `missingDependencies`, `resolveModules`, `isModuleKey` (shared); `CapabilitiesService.invalidateModules`; `AuditService.recordPlatform`; `platformAuditContext`.
- Produces:
  - `BusinessTypesService.list()`, `.create(input, ctx)`, `.update(id, input, ctx)` (invalidates module caches of every tenant using it).
  - `TenantModulesService.get(tenantId) → { base: string[]; overrides: { moduleKey: string; enabled: boolean }[]; resolved: ModuleKey[] }`, `.set(tenantId, { moduleKey, enabled }, ctx)`, `.clear(tenantId, moduleKey, ctx)`; both mutations reject unmet dependencies with `409 CONFLICT` and `details: [{ module, requires }]`.
  - Routes (admin host, super-admin token): `GET/POST /api/platform/business-types`, `PUT /api/platform/business-types/:id`, `GET /api/platform/tenants/:id/modules`, `PUT /api/platform/tenants/:id/modules` (body `{ moduleKey, enabled }`), `DELETE /api/platform/tenants/:id/modules/:moduleKey`.

- [ ] **Step 1: Write the failing tests**

`backend/test/platform-config.e2e.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createSuperAdmin, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword, loginSuperAdmin } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';
const cafe = {
  key: 'cafe-x',
  name: 'Café X',
  modules: ['core', 'modifiers', 'kitchen-display'],
  roleTemplates: [{ name: 'Barista', permissions: ['sale.create'], requiresMfa: false }],
};

describe('platform configuration', () => {
  let app: NestExpressApplication;
  let admin: string;
  const http = () => request(app.getHttpServer());
  const asAdmin = (r: request.Test) => r.set('Host', ADMIN_HOST).set(bearer(admin));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret });
    admin = await loginSuperAdmin(app, 'root@pos.lk', PW, secret);
  });

  it('requires a super-admin token', async () => {
    await http().get('/api/platform/business-types').set('Host', ADMIN_HOST).expect(401);
  });

  describe('business types', () => {
    it('creates and lists', async () => {
      const created = await asAdmin(http().post('/api/platform/business-types')).send(cafe).expect(201);
      expect(created.body).toMatchObject({ key: 'cafe-x', modules: ['core', 'modifiers', 'kitchen-display'] });
      const list = await asAdmin(http().get('/api/platform/business-types')).expect(200);
      expect(list.body.map((b: { key: string }) => b.key)).toContain('cafe-x');
      expect(await ownerDb().platformAuditEvent.count({ where: { action: 'business_type.created' } })).toBe(1);
    });

    it('rejects unmet module dependencies', async () => {
      const res = await asAdmin(http().post('/api/platform/business-types')).send({ ...cafe, modules: ['core', 'kitchen-display'] }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('rejects duplicate keys', async () => {
      await asAdmin(http().post('/api/platform/business-types')).send(cafe).expect(201);
      await asAdmin(http().post('/api/platform/business-types')).send(cafe).expect(409);
    });

    it('updating modules takes effect for tenants immediately', async () => {
      const t = await createTenant({ slug: 'acme', modules: ['core'] });
      await createUser(t.id, { email: 'a@acme.lk', password: PW });
      const token = await loginPassword(app, 'acme', 'a@acme.lk', PW);
      const before = await http().get('/api/me/capabilities').set('Host', hostFor('acme')).set(bearer(token)).expect(200);
      expect(before.body.modules).toEqual(['core']);
      const bt = await ownerDb().businessType.findUniqueOrThrow({ where: { id: t.businessTypeId } });
      await asAdmin(http().put(`/api/platform/business-types/${bt.id}`))
        .send({ key: bt.key, name: bt.name, modules: ['core', 'tables'], roleTemplates: bt.roleTemplates })
        .expect(200);
      const after = await http().get('/api/me/capabilities').set('Host', hostFor('acme')).set(bearer(token)).expect(200);
      expect(after.body.modules).toEqual(['core', 'tables']);
    });
  });

  describe('tenant module overrides', () => {
    it('refuses to enable a module whose dependency is off', async () => {
      const t = await createTenant({ slug: 'acme', modules: ['core'] });
      const res = await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'kitchen-display', enabled: true }).expect(409);
      expect(res.body.details).toEqual([{ module: 'kitchen-display', requires: 'modifiers' }]);
    });

    it('enables dependencies first, then the dependent', async () => {
      const t = await createTenant({ slug: 'acme', modules: ['core'] });
      await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'modifiers', enabled: true }).expect(200);
      const res = await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'kitchen-display', enabled: true }).expect(200);
      expect(res.body.resolved).toEqual(['core', 'kitchen-display', 'modifiers']);
    });

    it('refuses to disable a module others depend on', async () => {
      const t = await createTenant({ slug: 'acme', modules: ['core', 'modifiers', 'kitchen-display'] });
      const res = await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'modifiers', enabled: false }).expect(409);
      expect(res.body.details).toEqual([{ module: 'kitchen-display', requires: 'modifiers' }]);
    });

    it('clearing an override falls back to the business type', async () => {
      const t = await createTenant({ slug: 'acme', modules: ['core', 'tables'] });
      await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'tables', enabled: false }).expect(200);
      const cleared = await asAdmin(http().delete(`/api/platform/tenants/${t.id}/modules/tables`)).expect(200);
      expect(cleared.body).toMatchObject({ overrides: [], resolved: ['core', 'tables'] });
    });

    it('rejects overriding core', async () => {
      const t = await createTenant({ slug: 'acme' });
      await asAdmin(http().put(`/api/platform/tenants/${t.id}/modules`)).send({ moduleKey: 'core', enabled: false }).expect(400);
    });

    it('404s for an unknown tenant', async () => {
      await asAdmin(http().get('/api/platform/tenants/0190b6a0-0000-7000-8000-000000000099/modules')).expect(404);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/platform-config.e2e.spec.ts`
Expected: FAIL — routes 404.

- [ ] **Step 3: Implement**

`backend/src/modules/platform/business-types.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { BusinessTypeSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

type Input = z.infer<typeof BusinessTypeSchema>;
type Ctx = ReturnType<typeof platformAuditContext>;

const toData = (input: Input) => ({
  key: input.key,
  name: input.name,
  description: input.description ?? null,
  modules: input.modules,
  roleTemplates: input.roleTemplates as Prisma.InputJsonArray,
  defaultSettings: input.defaultSettings as Prisma.InputJsonObject,
});

@Injectable()
export class BusinessTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.prisma.businessType.findMany({ orderBy: { name: 'asc' } });
  }

  create(input: Input, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      const bt = await tx.businessType.create({ data: toData(input) });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'business_type.created', entityType: 'BusinessType', entityId: bt.id, after: bt });
      return bt;
    });
  }

  async update(id: string, input: Input, ctx: Ctx) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.businessType.findUnique({ where: { id } });
      if (!before) throw AppError.notFound('Business type not found');
      const bt = await tx.businessType.update({ where: { id }, data: toData(input) });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'business_type.updated', entityType: 'BusinessType', entityId: id, before, after: bt });
      return bt;
    });
    const tenants = await this.prisma.tenant.findMany({ where: { businessTypeId: id }, select: { id: true } });
    await this.capabilities.invalidateModules(tenants.map((t) => t.id));
    return updated;
  }
}
```

`backend/src/modules/platform/business-types.controller.ts`:
```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { BusinessTypeSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { BusinessTypesService } from './business-types.service.js';

@Realm('platform')
@Controller('platform/business-types')
export class BusinessTypesController {
  constructor(private readonly businessTypes: BusinessTypesService) {}

  @Get()
  list() {
    return this.businessTypes.list();
  }

  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(BusinessTypeSchema)) body: z.infer<typeof BusinessTypeSchema>) {
    return this.businessTypes.create(body, platformAuditContext(req));
  }

  @Put(':id')
  update(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(BusinessTypeSchema)) body: z.infer<typeof BusinessTypeSchema>,
  ) {
    return this.businessTypes.update(id, body, platformAuditContext(req));
  }
}
```

`backend/src/modules/platform/tenant-modules.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { applyOverrides, type ModuleOverride, missingDependencies, resolveModules } from '@pos/shared';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

type Ctx = ReturnType<typeof platformAuditContext>;

@Injectable()
export class TenantModulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly audit: AuditService,
  ) {}

  private async load(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, businessType: { select: { modules: true } }, moduleOverrides: { select: { moduleKey: true, enabled: true } } },
    });
    if (!tenant) throw AppError.notFound('Tenant not found');
    return { base: tenant.businessType.modules, overrides: tenant.moduleOverrides };
  }

  async get(tenantId: string) {
    const { base, overrides } = await this.load(tenantId);
    return { base, overrides, resolved: resolveModules(base, overrides) };
  }

  private assertSatisfiable(base: string[], overrides: ModuleOverride[]) {
    const missing = missingDependencies(applyOverrides(base, overrides));
    if (missing.length) throw AppError.conflict('Module dependencies not satisfied', missing);
  }

  async set(tenantId: string, input: { moduleKey: string; enabled: boolean }, ctx: Ctx) {
    const { base, overrides } = await this.load(tenantId);
    const candidate = [...overrides.filter((o) => o.moduleKey !== input.moduleKey), input];
    this.assertSatisfiable(base, candidate);
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantModule.upsert({
        where: { tenantId_moduleKey: { tenantId, moduleKey: input.moduleKey } },
        update: { enabled: input.enabled },
        create: { tenantId, moduleKey: input.moduleKey, enabled: input.enabled },
      });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.module_override_set', entityType: 'Tenant', entityId: tenantId, after: input });
    });
    await this.capabilities.invalidateModules([tenantId]);
    return this.get(tenantId);
  }

  async clear(tenantId: string, moduleKey: string, ctx: Ctx) {
    const { base, overrides } = await this.load(tenantId);
    this.assertSatisfiable(base, overrides.filter((o) => o.moduleKey !== moduleKey));
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantModule.deleteMany({ where: { tenantId, moduleKey } });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.module_override_cleared', entityType: 'Tenant', entityId: tenantId, after: { moduleKey } });
    });
    await this.capabilities.invalidateModules([tenantId]);
    return this.get(tenantId);
  }
}
```

`backend/src/modules/platform/tenant-modules.controller.ts`:
```ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { isModuleKey, ModuleOverrideSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { TenantModulesService } from './tenant-modules.service.js';

@Realm('platform')
@Controller('platform/tenants/:id/modules')
export class TenantModulesController {
  constructor(private readonly modules: TenantModulesService) {}

  @Get()
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.modules.get(id);
  }

  @Put()
  set(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(ModuleOverrideSchema)) body: z.infer<typeof ModuleOverrideSchema>,
  ) {
    return this.modules.set(id, body, platformAuditContext(req));
  }

  @Delete(':moduleKey')
  clear(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('moduleKey') moduleKey: string) {
    if (!isModuleKey(moduleKey) || moduleKey === 'core') throw AppError.validation([{ path: 'moduleKey', message: 'Unknown module' }]);
    return this.modules.clear(id, moduleKey, platformAuditContext(req));
  }
}
```

`backend/src/modules/platform/platform.module.ts`: add `BusinessTypesController`, `TenantModulesController` to `controllers` and `BusinessTypesService`, `TenantModulesService` to `providers`.

Note: `PUT` returns 200 and `DELETE` returns 200 with the new state (Nest defaults: POST 201, others 200).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/platform backend/test/platform-config.e2e.spec.ts
git commit -m "feat(platform): business type builder and dependency-checked per-tenant module overrides"
```

---
### Task 15: Tenant lifecycle — create, list, suspend, change business type, delete

**Files:**
- Create: `backend/src/modules/platform/tenants.service.ts`, `backend/src/modules/platform/tenants.controller.ts`
- Modify: `backend/src/modules/platform/platform.module.ts`
- Test: `backend/test/tenants.e2e.spec.ts`

**Interfaces:**
- Consumes: `CreateTenantSchema`, `UpdateTenantStatusSchema`, `ChangeBusinessTypeSchema`, `RoleTemplateSchema`, `PERMISSIONS` (shared); `TenantDb`, `TenantResolverService`, `CapabilitiesService`, `AuditService`, `ENV`.
- Produces:
  - `OWNER_ROLE_NAME = 'Owner'`, `OWNER_SETUP_TTL_MS = 7 days`.
  - `TenantsService.create(input, ctx) → { tenant, owner: { id, email }, ownerSetupCode: string, host: string }` — one transaction creates the tenant, the system Owner role (all permissions, MFA required), the business type's template roles, and the owner user with a one-time setup code; writes tenant and platform audit events.
  - `.list()`, `.get(id)`, `.setStatus(id, status, ctx)`, `.changeBusinessType(id, businessTypeId, ctx)` (adds missing template roles, never deletes), `.softDelete(id, ctx)`.
  - Routes (admin host): `POST /api/platform/tenants`, `GET /api/platform/tenants`, `GET /api/platform/tenants/:id`, `PATCH /api/platform/tenants/:id/status`, `PATCH /api/platform/tenants/:id/business-type`, `DELETE /api/platform/tenants/:id` (204).

- [ ] **Step 1: Write the failing tests**

`backend/test/tenants.e2e.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PERMISSIONS } from '@pos/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode } from '../src/common/crypto/base32.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createBusinessType, createPlan, createSuperAdmin, hostFor } from './helpers/fixtures.js';
import { bearer, loginSuperAdmin, nextTotp } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('tenant lifecycle', () => {
  let app: NestExpressApplication;
  let admin: string;
  let businessTypeId: string;
  const http = () => request(app.getHttpServer());
  const asAdmin = (r: request.Test) => r.set('Host', ADMIN_HOST).set(bearer(admin));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    await ownerDb().plan.create({ data: { key: 'standard', name: 'Standard', maxStores: 3, maxDevices: 10, maxUsers: 25 } });
    businessTypeId = (await createBusinessType({ modules: ['core', 'tables'] })).id;
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret });
    admin = await loginSuperAdmin(app, 'root@pos.lk', PW, secret);
  });

  const newTenant = (slug = 'acme') => ({ name: 'Acme Stores', slug, businessTypeId, ownerEmail: 'owner@acme.lk', ownerName: 'Acme Owner' });

  async function ownerToken(setupCode: string, slug = 'acme') {
    const host = hostFor(slug);
    await http().post('/api/auth/setup-password').set('Host', host).send({ code: setupCode, password: PW }).expect(204);
    const login = await http().post('/api/auth/login').set('Host', host).send({ email: 'owner@acme.lk', password: PW }).expect(200);
    expect(login.body.status).toBe('mfa_setup_required');
    const verified = await http()
      .post('/api/auth/mfa/verify')
      .set('Host', host)
      .send({ mfaToken: login.body.mfaToken, code: nextTotp(base32Decode(login.body.secret)) })
      .expect(200);
    return verified.body.accessToken as string;
  }

  it('creates a tenant whose owner can onboard and holds every permission', async () => {
    const res = await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    expect(res.body).toMatchObject({ host: 'acme.pos.localhost', owner: { email: 'owner@acme.lk' }, tenant: { slug: 'acme', status: 'ACTIVE' } });
    expect(res.body.ownerSetupCode).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const roles = await ownerDb().role.findMany({ where: { tenantId: res.body.tenant.id }, orderBy: { name: 'asc' } });
    expect(roles.map((r) => r.name)).toEqual(['Cashier', 'Owner']);
    expect(roles.find((r) => r.name === 'Owner')).toMatchObject({ requiresMfa: true, isSystem: true });

    const token = await ownerToken(res.body.ownerSetupCode);
    const caps = await http().get('/api/me/capabilities').set('Host', hostFor('acme')).set(bearer(token)).expect(200);
    expect(caps.body.permissions).toEqual([...PERMISSIONS].sort());
    expect(caps.body.modules).toEqual(['core', 'tables']);
    expect(await ownerDb().platformAuditEvent.count({ where: { action: 'tenant.created' } })).toBe(1);
  });

  it('clears a cached "unknown host" when the tenant is created', async () => {
    await http().post('/api/auth/login').set('Host', hostFor('acme')).send({ email: 'x@y.lk', password: 'x' }).expect(404);
    const res = await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    await http().post('/api/auth/setup-password').set('Host', hostFor('acme')).send({ code: res.body.ownerSetupCode, password: PW }).expect(204);
  });

  it('rejects duplicate and reserved slugs, unknown business types and plans', async () => {
    await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(409);
    await asAdmin(http().post('/api/platform/tenants')).send(newTenant('admin')).expect(400);
    await asAdmin(http().post('/api/platform/tenants')).send({ ...newTenant('zeta'), businessTypeId: '0190b6a0-0000-7000-8000-000000000099' }).expect(404);
    await asAdmin(http().post('/api/platform/tenants')).send({ ...newTenant('zeta'), planKey: 'nope' }).expect(404);
  });

  it('suspension takes effect immediately and is reversible', async () => {
    const res = await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    const token = await ownerToken(res.body.ownerSetupCode);
    await asAdmin(http().patch(`/api/platform/tenants/${res.body.tenant.id}/status`)).send({ status: 'SUSPENDED' }).expect(200);
    const blocked = await http().get('/api/me').set('Host', hostFor('acme')).set(bearer(token)).expect(403);
    expect(blocked.body.code).toBe('TENANT_SUSPENDED');
    await asAdmin(http().patch(`/api/platform/tenants/${res.body.tenant.id}/status`)).send({ status: 'ACTIVE' }).expect(200);
    await http().get('/api/me').set('Host', hostFor('acme')).set(bearer(token)).expect(200);
  });

  it('changing the business type switches modules and adds missing template roles', async () => {
    const res = await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    const token = await ownerToken(res.body.ownerSetupCode);
    const pharmacy = await ownerDb().businessType.create({
      data: {
        key: 'pharmacy-x',
        name: 'Pharmacy',
        modules: ['core', 'customers', 'batch-expiry', 'prescriptions'],
        roleTemplates: [
          { name: 'Cashier', permissions: ['sale.create'], requiresMfa: false },
          { name: 'Pharmacist', permissions: ['sale.create', 'sale.refund'], requiresMfa: true },
        ],
      },
    });
    await asAdmin(http().patch(`/api/platform/tenants/${res.body.tenant.id}/business-type`)).send({ businessTypeId: pharmacy.id }).expect(200);
    const caps = await http().get('/api/me/capabilities').set('Host', hostFor('acme')).set(bearer(token)).expect(200);
    expect(caps.body.modules).toEqual(['batch-expiry', 'core', 'customers', 'prescriptions']);
    const roles = await ownerDb().role.findMany({ where: { tenantId: res.body.tenant.id }, orderBy: { name: 'asc' } });
    expect(roles.map((r) => r.name)).toEqual(['Cashier', 'Owner', 'Pharmacist']);
  });

  it('soft-deletes: the host disappears and the tenant leaves the list', async () => {
    const res = await asAdmin(http().post('/api/platform/tenants')).send(newTenant()).expect(201);
    await asAdmin(http().delete(`/api/platform/tenants/${res.body.tenant.id}`)).expect(204);
    await http().post('/api/auth/login').set('Host', hostFor('acme')).send({ email: 'owner@acme.lk', password: PW }).expect(404);
    const list = await asAdmin(http().get('/api/platform/tenants')).expect(200);
    expect(list.body).toEqual([]);
  });

  it('uses the plan the request names', async () => {
    const premium = await createPlan({ maxStores: 50 });
    const res = await asAdmin(http().post('/api/platform/tenants')).send({ ...newTenant(), planKey: premium.key }).expect(201);
    expect(res.body.tenant.plan.key).toBe(premium.key);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/tenants.e2e.spec.ts`
Expected: FAIL — `/api/platform/tenants` 404.

- [ ] **Step 3: Implement**

`backend/src/modules/platform/tenants.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { type CreateTenantSchema, PERMISSIONS, RoleTemplateSchema } from '@pos/shared';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { randomToken, sha256Hex } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import { ENV, type Env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService, type Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import { TenantResolverService } from '../access/tenant-resolver.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

export const OWNER_ROLE_NAME = 'Owner';
export const OWNER_SETUP_TTL_MS = 7 * 24 * 3_600_000;

type Ctx = ReturnType<typeof platformAuditContext>;

const detailInclude = {
  businessType: { select: { id: true, key: true, name: true } },
  plan: { select: { id: true, key: true, name: true, maxStores: true, maxDevices: true, maxUsers: true } },
  domains: { select: { id: true, hostname: true, verifiedAt: true, lastCheckedAt: true } },
  moduleOverrides: { select: { moduleKey: true, enabled: true } },
} as const;

@Injectable()
export class TenantsService {
  private readonly base: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly resolver: TenantResolverService,
    private readonly capabilities: CapabilitiesService,
    private readonly audit: AuditService,
    @Inject(ENV) env: Env,
  ) {
    this.base = env.PLATFORM_DOMAIN;
  }

  private async addTemplateRoles(tx: Tx, tenantId: string, roleTemplates: unknown) {
    const templates = RoleTemplateSchema.array().parse(roleTemplates);
    const existing = new Set((await tx.role.findMany({ select: { name: true } })).map((r) => r.name));
    const missing = templates.filter((t) => !existing.has(t.name));
    if (missing.length) {
      await tx.role.createMany({
        data: missing.map((t) => ({ tenantId, name: t.name, permissions: t.permissions, requiresMfa: t.requiresMfa, isSystem: true })),
      });
    }
    return missing.map((t) => t.name);
  }

  async create(input: z.infer<typeof CreateTenantSchema>, ctx: Ctx) {
    const [bt, plan] = await Promise.all([
      this.prisma.businessType.findUnique({ where: { id: input.businessTypeId } }),
      this.prisma.plan.findUnique({ where: { key: input.planKey } }),
    ]);
    if (!bt) throw AppError.notFound('Business type not found');
    if (!plan) throw AppError.notFound('Plan not found');

    const id = uuidv7();
    const ownerSetupCode = randomToken(24);
    const owner = await this.tenantDb.run(id, async (tx) => {
      await tx.tenant.create({
        data: {
          id,
          name: input.name,
          slug: input.slug,
          businessTypeId: bt.id,
          planId: plan.id,
          country: input.country,
          currency: input.currency,
          timezone: input.timezone,
          settings: bt.defaultSettings as Prisma.InputJsonValue,
        },
      });
      const ownerRole = await tx.role.create({
        data: { tenantId: id, name: OWNER_ROLE_NAME, permissions: [...PERMISSIONS], requiresMfa: true, isSystem: true },
      });
      await this.addTemplateRoles(tx, id, bt.roleTemplates);
      const user = await tx.user.create({
        data: {
          tenantId: id,
          name: input.ownerName,
          email: input.ownerEmail,
          setupTokenHash: sha256Hex(ownerSetupCode),
          setupTokenExpiresAt: new Date(Date.now() + OWNER_SETUP_TTL_MS),
        },
      });
      await tx.userRole.create({ data: { tenantId: id, userId: user.id, roleId: ownerRole.id } });
      const summary = { slug: input.slug, businessType: bt.key, plan: plan.key, ownerEmail: input.ownerEmail };
      await this.audit.record(tx, id, {
        ip: ctx.ip, userAgent: ctx.userAgent, correlationId: ctx.correlationId,
        action: 'tenant.created', entityType: 'Tenant', entityId: id, after: { ...summary, bySuperAdmin: ctx.actorId },
      });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.created', entityType: 'Tenant', entityId: id, after: summary });
      return user;
    });

    // A lookup before creation may have cached this host as unknown.
    await this.resolver.invalidateHosts([`${input.slug}.${this.base}`]);
    return { tenant: await this.get(id), owner: { id: owner.id, email: owner.email }, ownerSetupCode, host: `${input.slug}.${this.base}` };
  }

  list() {
    return this.prisma.tenant.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, name: true, slug: true, status: true, country: true, currency: true, createdAt: true,
        businessType: { select: { key: true, name: true } },
        plan: { select: { key: true } },
      },
    });
  }

  async get(id: string) {
    const tenant = await this.prisma.tenant.findFirst({ where: { id, deletedAt: null }, include: detailInclude });
    if (!tenant) throw AppError.notFound('Tenant not found');
    return tenant;
  }

  async setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED', ctx: Ctx) {
    const before = await this.get(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id }, data: { status } });
      await this.audit.recordPlatform(tx, {
        ...ctx, action: 'tenant.status_changed', entityType: 'Tenant', entityId: id, before: { status: before.status }, after: { status },
      });
    });
    await this.resolver.invalidateTenant(id);
    return this.get(id);
  }

  async changeBusinessType(id: string, businessTypeId: string, ctx: Ctx) {
    const before = await this.get(id);
    const bt = await this.prisma.businessType.findUnique({ where: { id: businessTypeId } });
    if (!bt) throw AppError.notFound('Business type not found');
    await this.tenantDb.run(id, async (tx) => {
      await tx.tenant.update({ where: { id }, data: { businessTypeId } });
      const added = await this.addTemplateRoles(tx, id, bt.roleTemplates);
      const change = { from: before.businessType.key, to: bt.key, rolesAdded: added };
      await this.audit.record(tx, id, {
        ip: ctx.ip, userAgent: ctx.userAgent, correlationId: ctx.correlationId,
        action: 'tenant.business_type_changed', entityType: 'Tenant', entityId: id, after: { ...change, bySuperAdmin: ctx.actorId },
      });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.business_type_changed', entityType: 'Tenant', entityId: id, after: change });
    });
    await Promise.all([this.resolver.invalidateTenant(id), this.capabilities.invalidateModules([id])]);
    return this.get(id);
  }

  async softDelete(id: string, ctx: Ctx) {
    await this.get(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id }, data: { deletedAt: new Date(), status: 'SUSPENDED' } });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.deleted', entityType: 'Tenant', entityId: id });
    });
    await this.resolver.invalidateTenant(id);
  }
}
```

`backend/src/modules/platform/tenants.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ChangeBusinessTypeSchema, CreateTenantSchema, UpdateTenantStatusSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { TenantsService } from './tenants.service.js';

@Realm('platform')
@Controller('platform/tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateTenantSchema)) body: z.infer<typeof CreateTenantSchema>) {
    return this.tenants.create(body, platformAuditContext(req));
  }

  @Get()
  list() {
    return this.tenants.list();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.tenants.get(id);
  }

  @Patch(':id/status')
  setStatus(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(UpdateTenantStatusSchema)) body: z.infer<typeof UpdateTenantStatusSchema>,
  ) {
    return this.tenants.setStatus(id, body.status, platformAuditContext(req));
  }

  @Patch(':id/business-type')
  changeBusinessType(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(ChangeBusinessTypeSchema)) body: z.infer<typeof ChangeBusinessTypeSchema>,
  ) {
    return this.tenants.changeBusinessType(id, body.businessTypeId, platformAuditContext(req));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.tenants.softDelete(id, platformAuditContext(req));
  }
}
```

`backend/src/modules/platform/platform.module.ts`: add `TenantsController` and `TenantsService`; export `TenantsService` is not needed.

Note: `TenantModulesController` is mounted at `platform/tenants/:id/modules`; Nest resolves it alongside `TenantsController` without conflict because the paths differ in segment count.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/platform backend/test/tenants.e2e.spec.ts
git commit -m "feat(platform): tenant onboarding with owner setup code, suspension, business type changes, soft delete"
```

---

### Task 16: Custom domains, DNS verification, Caddy on-demand TLS

**Files:**
- Create: `backend/src/modules/platform/domains.service.ts`, `backend/src/modules/platform/domains.controller.ts`, `backend/src/modules/platform/domain-recheck.job.ts`, `backend/src/modules/platform/caddy.controller.ts`
- Modify: `backend/src/modules/platform/platform.module.ts`, `backend/src/app.module.ts` (add `ScheduleModule.forRoot()`)
- Create: `infra/caddy/Caddyfile`
- Test: `backend/test/domains.e2e.spec.ts`

**Interfaces:**
- Consumes: `AddDomainSchema`; `TenantResolverService`, `AuditService`, `randomToken`, `ENV`.
- Produces:
  - `DNS_RESOLVER` (injection token), `interface DnsResolver { resolveTxt(name: string): Promise<string[][]> }` (default: `node:dns/promises`).
  - `TXT_PREFIX = '_pos-verify'`; the TXT record is `_pos-verify.<hostname>` with value `pos-verify=<token>`.
  - `DomainsService.add(tenantId, hostname, ctx)`, `.list(tenantId)`, `.verify(tenantId, domainId, ctx) → { …, verified: boolean }`, `.remove(tenantId, domainId, ctx)`, `.recheckAll() → { checked: number; unverified: number }` (only definite DNS answers — `ENOTFOUND`, `ENODATA`, or a missing value — unverify; transient errors keep the domain).
  - `DomainRecheckJob` (cron `0 3 * * *`, Asia/Colombo).
  - Routes: `POST/GET /api/platform/tenants/:id/domains`, `POST /api/platform/tenants/:id/domains/:domainId/verify`, `DELETE /api/platform/tenants/:id/domains/:domainId` (204); `GET /api/internal/caddy/ask?domain=` (any host, public; 200 only for the admin host, active tenant slugs and verified custom domains).

- [ ] **Step 1: Write the failing tests**

`backend/test/domains.e2e.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantResolverService } from '../src/modules/access/tenant-resolver.service.js';
import { DNS_RESOLVER, type DnsResolver, DomainsService } from '../src/modules/platform/domains.service.js';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createSuperAdmin, createTenant, hostFor } from './helpers/fixtures.js';
import { bearer, loginSuperAdmin } from './helpers/http.js';
import { ProbeController } from './helpers/probe.controller.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';
const txt = new Map<string, string[][] | Error>();
const fakeDns: DnsResolver = {
  async resolveTxt(name) {
    const v = txt.get(name);
    if (v instanceof Error) throw v;
    if (!v) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
    return v;
  },
};

describe('custom domains', () => {
  let app: NestExpressApplication;
  let admin: string;
  let tenantId: string;
  const http = () => request(app.getHttpServer());
  const asAdmin = (r: request.Test) => r.set('Host', ADMIN_HOST).set(bearer(admin));

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ProbeController], customize: (b) => b.overrideProvider(DNS_RESOLVER).useValue(fakeDns) });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    txt.clear();
    tenantId = (await createTenant({ slug: 'acme' })).id;
    const secret = randomBytes(20);
    await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret });
    admin = await loginSuperAdmin(app, 'root@pos.lk', PW, secret);
  });

  async function addDomain(hostname = 'shop.acme.lk') {
    return asAdmin(http().post(`/api/platform/tenants/${tenantId}/domains`)).send({ hostname }).expect(201);
  }

  it('returns TXT instructions, verifies, then serves the tenant on that host', async () => {
    const added = await addDomain('Shop.Acme.LK');
    expect(added.body).toMatchObject({ hostname: 'shop.acme.lk', txtName: '_pos-verify.shop.acme.lk', verifiedAt: null });
    expect(added.body.txtValue).toMatch(/^pos-verify=/);
    await http().get('/api/probe/tenant').set('Host', 'shop.acme.lk').expect(404);

    txt.set('_pos-verify.shop.acme.lk', [['some-other-record'], [added.body.txtValue]]);
    const verified = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/domains/${added.body.id}/verify`)).expect(200);
    expect(verified.body.verified).toBe(true);
    const probe = await http().get('/api/probe/tenant').set('Host', 'shop.acme.lk').expect(200);
    expect(probe.body.tenantId).toBe(tenantId);
  });

  it('stays unverified when the TXT value is wrong', async () => {
    const added = await addDomain();
    txt.set('_pos-verify.shop.acme.lk', [['pos-verify=wrong']]);
    const res = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/domains/${added.body.id}/verify`)).expect(200);
    expect(res.body.verified).toBe(false);
  });

  it('refuses platform-domain hostnames and duplicates', async () => {
    await asAdmin(http().post(`/api/platform/tenants/${tenantId}/domains`)).send({ hostname: 'evil.pos.localhost' }).expect(400);
    await addDomain();
    const other = await createTenant({ slug: 'other' });
    await asAdmin(http().post(`/api/platform/tenants/${other.id}/domains`)).send({ hostname: 'shop.acme.lk' }).expect(409);
  });

  it('cannot verify another tenant’s domain through the wrong tenant path', async () => {
    const added = await addDomain();
    const other = await createTenant({ slug: 'other' });
    await asAdmin(http().post(`/api/platform/tenants/${other.id}/domains/${added.body.id}/verify`)).expect(404);
  });

  describe('caddy ask', () => {
    const ask = (domain: string) => http().get(`/api/internal/caddy/ask?domain=${encodeURIComponent(domain)}`).set('Host', 'localhost');

    it('allows the admin host, active slugs and verified domains only', async () => {
      await createTenant({ slug: 'sleepy', status: 'SUSPENDED' });
      const added = await addDomain();
      await ask(ADMIN_HOST).expect(200);
      await ask(hostFor('acme')).expect(200);
      await ask(hostFor('nobody')).expect(404);
      await ask(hostFor('sleepy')).expect(404);
      await ask('shop.acme.lk').expect(404);
      await ownerDb().domain.update({ where: { id: added.body.id }, data: { verifiedAt: new Date() } });
      await app.get(TenantResolverService).invalidateHosts(['shop.acme.lk']); // the 404 above was cached
      await ask('shop.acme.lk').expect(200);
      await http().get('/api/internal/caddy/ask').set('Host', 'localhost').expect(404);
    });
  });

  describe('daily recheck', () => {
    it('unverifies domains whose record is gone, keeps them on transient DNS errors', async () => {
      const gone = await addDomain('gone.acme.lk');
      const flaky = await addDomain('flaky.acme.lk');
      await ownerDb().domain.updateMany({ data: { verifiedAt: new Date() } });
      txt.set('_pos-verify.flaky.acme.lk', Object.assign(new Error('queryTxt ETIMEOUT'), { code: 'ETIMEOUT' }));
      const result = await app.get(DomainsService).recheckAll();
      expect(result).toEqual({ checked: 2, unverified: 1 });
      const rows = await ownerDb().domain.findMany({ orderBy: { hostname: 'asc' } });
      expect(rows.find((d) => d.id === flaky.body.id)?.verifiedAt).not.toBeNull();
      expect(rows.find((d) => d.id === gone.body.id)?.verifiedAt).toBeNull();
      await http().get('/api/probe/tenant').set('Host', 'gone.acme.lk').expect(404);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/domains.e2e.spec.ts`
Expected: FAIL — `domains.service.js` not found.

- [ ] **Step 3: Implement**

`backend/src/modules/platform/domains.service.ts`:
```ts
import { resolveTxt } from 'node:dns/promises';
import { Inject, Injectable } from '@nestjs/common';
import { randomToken } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import { ENV, type Env } from '../../config/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { TenantResolverService } from '../access/tenant-resolver.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

export const DNS_RESOLVER = Symbol('DNS_RESOLVER');
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
}
export const systemDnsResolver: DnsResolver = { resolveTxt: (name) => resolveTxt(name) };

export const TXT_PREFIX = '_pos-verify';
type Ctx = ReturnType<typeof platformAuditContext>;
type DomainRow = { id: string; hostname: string; verificationToken: string; verifiedAt: Date | null; lastCheckedAt: Date | null };

@Injectable()
export class DomainsService {
  private readonly base: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: TenantResolverService,
    private readonly audit: AuditService,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(ENV) env: Env,
  ) {
    this.base = env.PLATFORM_DOMAIN;
  }

  private view(d: DomainRow) {
    return {
      id: d.id,
      hostname: d.hostname,
      verifiedAt: d.verifiedAt,
      lastCheckedAt: d.lastCheckedAt,
      txtName: `${TXT_PREFIX}.${d.hostname}`,
      txtValue: `pos-verify=${d.verificationToken}`,
    };
  }

  private async lookup(d: DomainRow): Promise<'present' | 'absent' | 'error'> {
    try {
      const records = await this.dns.resolveTxt(`${TXT_PREFIX}.${d.hostname}`);
      return records.map((chunks) => chunks.join('')).includes(`pos-verify=${d.verificationToken}`) ? 'present' : 'absent';
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'ENOTFOUND' || code === 'ENODATA' ? 'absent' : 'error';
    }
  }

  private async findOwned(tenantId: string, domainId: string) {
    const d = await this.prisma.domain.findFirst({ where: { id: domainId, tenantId } });
    if (!d) throw AppError.notFound('Domain not found');
    return d;
  }

  async add(tenantId: string, hostname: string, ctx: Ctx) {
    if (hostname === this.base || hostname.endsWith(`.${this.base}`)) {
      throw AppError.validation([{ path: 'hostname', message: 'Platform subdomains are assigned automatically' }]);
    }
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
    if (!tenant) throw AppError.notFound('Tenant not found');
    const domain = await this.prisma.$transaction(async (tx) => {
      const d = await tx.domain.create({ data: { tenantId, hostname, verificationToken: randomToken(24) } });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'domain.added', entityType: 'Domain', entityId: d.id, after: { tenantId, hostname } });
      return d;
    });
    return this.view(domain);
  }

  async list(tenantId: string) {
    const rows = await this.prisma.domain.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
    return rows.map((d) => this.view(d));
  }

  async verify(tenantId: string, domainId: string, ctx: Ctx) {
    const d = await this.findOwned(tenantId, domainId);
    const result = await this.lookup(d);
    const now = new Date();
    if (result !== 'present') {
      const updated = await this.prisma.domain.update({ where: { id: d.id }, data: { lastCheckedAt: now } });
      return { ...this.view(updated), verified: false };
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.domain.update({ where: { id: d.id }, data: { verifiedAt: d.verifiedAt ?? now, lastCheckedAt: now } });
      if (!d.verifiedAt) {
        await this.audit.recordPlatform(tx, { ...ctx, action: 'domain.verified', entityType: 'Domain', entityId: d.id, after: { hostname: d.hostname } });
      }
      return row;
    });
    await this.resolver.invalidateHosts([d.hostname]);
    return { ...this.view(updated), verified: true };
  }

  async remove(tenantId: string, domainId: string, ctx: Ctx) {
    const d = await this.findOwned(tenantId, domainId);
    await this.prisma.$transaction(async (tx) => {
      await tx.domain.delete({ where: { id: d.id } });
      await this.audit.recordPlatform(tx, { ...ctx, action: 'domain.removed', entityType: 'Domain', entityId: d.id, before: { hostname: d.hostname } });
    });
    await this.resolver.invalidateHosts([d.hostname]);
  }

  async recheckAll(): Promise<{ checked: number; unverified: number }> {
    const domains = await this.prisma.domain.findMany({ where: { verifiedAt: { not: null } } });
    let unverified = 0;
    for (const d of domains) {
      const result = await this.lookup(d);
      if (result === 'error') continue;
      if (result === 'present') {
        await this.prisma.domain.update({ where: { id: d.id }, data: { lastCheckedAt: new Date() } });
        continue;
      }
      unverified++;
      await this.prisma.$transaction(async (tx) => {
        await tx.domain.update({ where: { id: d.id }, data: { verifiedAt: null, lastCheckedAt: new Date() } });
        await this.audit.recordPlatform(tx, { action: 'domain.unverified', entityType: 'Domain', entityId: d.id, after: { hostname: d.hostname } });
      });
      await this.resolver.invalidateHosts([d.hostname]);
    }
    return { checked: domains.length, unverified };
  }
}
```

`backend/src/modules/platform/domain-recheck.job.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DomainsService } from './domains.service.js';

@Injectable()
export class DomainRecheckJob {
  private readonly logger = new Logger(DomainRecheckJob.name);

  constructor(private readonly domains: DomainsService) {}

  @Cron('0 3 * * *', { name: 'domain-recheck', timeZone: 'Asia/Colombo' })
  async run() {
    const result = await this.domains.recheckAll();
    this.logger.log(`Domain recheck: ${result.checked} checked, ${result.unverified} unverified`);
  }
}
```

`backend/src/modules/platform/domains.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { AddDomainSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { DomainsService } from './domains.service.js';

@Realm('platform')
@Controller('platform/tenants/:id/domains')
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Post()
  add(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(AddDomainSchema)) body: z.infer<typeof AddDomainSchema>,
  ) {
    return this.domains.add(id, body.hostname, platformAuditContext(req));
  }

  @Get()
  list(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.domains.list(id);
  }

  @Post(':domainId/verify')
  @HttpCode(200)
  verify(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('domainId', new ParseUUIDPipe()) domainId: string) {
    return this.domains.verify(id, domainId, platformAuditContext(req));
  }

  @Delete(':domainId')
  @HttpCode(204)
  async remove(@Req() req: RequestWithContext, @Param('id', new ParseUUIDPipe()) id: string, @Param('domainId', new ParseUUIDPipe()) domainId: string) {
    await this.domains.remove(id, domainId, platformAuditContext(req));
  }
}
```

`backend/src/modules/platform/caddy.controller.ts`:
```ts
import { Controller, Get, Query } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { Public, Realm } from '../access/decorators.js';
import { TenantResolverService } from '../access/tenant-resolver.service.js';

/**
 * Caddy's on-demand TLS "ask" hook: a certificate is only issued for hosts we serve.
 * The public edge blocks /api/internal/*; Caddy calls the backend directly.
 */
@Realm('any')
@Public()
@Controller('internal/caddy')
export class CaddyController {
  constructor(private readonly resolver: TenantResolverService) {}

  @Get('ask')
  async ask(@Query('domain') domain?: string) {
    const r = await this.resolver.resolveHost(domain);
    if (r.realm === 'platform' || (r.realm === 'tenant' && r.tenant?.status === 'ACTIVE')) return { ok: true };
    throw AppError.notFound();
  }
}
```

`backend/src/modules/platform/platform.module.ts` (replace; final version):
```ts
import { Module } from '@nestjs/common';
import { BusinessTypesController } from './business-types.controller.js';
import { BusinessTypesService } from './business-types.service.js';
import { CaddyController } from './caddy.controller.js';
import { DomainRecheckJob } from './domain-recheck.job.js';
import { DomainsController } from './domains.controller.js';
import { DNS_RESOLVER, DomainsService, systemDnsResolver } from './domains.service.js';
import { ImpersonationController } from './impersonation.controller.js';
import { ImpersonationService } from './impersonation.service.js';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformSessionService } from './platform-session.service.js';
import { TenantModulesController } from './tenant-modules.controller.js';
import { TenantModulesService } from './tenant-modules.service.js';
import { TenantsController } from './tenants.controller.js';
import { TenantsService } from './tenants.service.js';

@Module({
  controllers: [
    PlatformAuthController,
    BusinessTypesController,
    TenantsController,
    TenantModulesController,
    DomainsController,
    CaddyController,
    ImpersonationController,
  ],
  providers: [
    PlatformAuthService,
    PlatformSessionService,
    BusinessTypesService,
    TenantsService,
    TenantModulesService,
    DomainsService,
    DomainRecheckJob,
    ImpersonationService,
    { provide: DNS_RESOLVER, useValue: systemDnsResolver },
  ],
})
export class PlatformModule {}
```
The two `Impersonation*` entries are created in Task 17. For this task, leave those two imports and entries out; Task 17 adds them back.

`backend/src/app.module.ts`: add `ScheduleModule.forRoot()` to `imports` with `import { ScheduleModule } from '@nestjs/schedule';`.

`infra/caddy/Caddyfile`:
```
# Local development edge. Production config ships with the deploy milestone.
{
	on_demand_tls {
		ask http://host.docker.internal:3000/api/internal/caddy/ask
	}
}

https:// {
	tls internal {
		on_demand
	}

	@internal path /api/internal/*
	respond @internal 404

	handle /api/* {
		reverse_proxy host.docker.internal:3000
	}

	handle {
		respond "POS frontend is not built yet (Plan 1b)." 200
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 5: Manual edge check (optional, needs a tenant)**

With the API running (`npm run dev:api`) and a tenant `acme` created through the API:
```bash
docker compose -f infra/docker-compose.yml --profile edge up -d caddy
curl -sk https://acme.pos.localhost/api/health      # → {"status":"ok"}
curl -sk -o /dev/null -w "%{http_code}\n" https://acme.pos.localhost/api/internal/caddy/ask?domain=x   # → 404
```
`*.localhost` resolves to 127.0.0.1 in curl and Chromium. The certificate comes from Caddy's internal CA, hence `-k`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/platform backend/src/app.module.ts infra/caddy backend/test/domains.e2e.spec.ts
git commit -m "feat(platform): custom domains with DNS TXT verification, daily recheck, Caddy on-demand TLS gate"
```

---

### Task 17: Audited, time-boxed super-admin impersonation

**Files:**
- Create: `backend/src/modules/platform/impersonation.service.ts`, `backend/src/modules/platform/impersonation.controller.ts`
- Modify: `backend/src/modules/platform/platform.module.ts` (add the two entries left out in Task 16)
- Test: `backend/test/impersonation.e2e.spec.ts`

**Interfaces:**
- Consumes: `ImpersonateSchema`; `TenantDb`, `TokenService`, `RevocationStore`, `AuditService`, `OWNER_ROLE_NAME`, `platformAuditContext`.
- Produces:
  - `IMPERSONATION_TTL_SEC = 1800`.
  - `ImpersonationService.start(tenantId, { reason, userId? }, ctx) → { accessToken, expiresIn, sessionId, host, userId }` — tenant access token with `imp = superAdminId`, `sid = sessionId`, no refresh token; audited in both logs with the reason.
  - `.end(sessionId, ctx)` — revokes the token for its remaining life.
  - Routes: `POST /api/platform/tenants/:id/impersonate` (201), `POST /api/platform/impersonations/:sessionId/end` (204).

- [ ] **Step 1: Write the failing tests**

`backend/test/impersonation.e2e.spec.ts`:
```ts
import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { ADMIN_HOST, createRegister, createStore, createSuperAdmin, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginSuperAdmin } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('impersonation', () => {
  let app: NestExpressApplication;
  let admin: string;
  let adminId: string;
  let tenantId: string;
  let ownerId: string;
  const http = () => request(app.getHttpServer());
  const asAdmin = (r: request.Test) => r.set('Host', ADMIN_HOST).set(bearer(admin));
  const reason = 'Customer ticket #4411: cannot see their registers';

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme' })).id;
    // The system Owner role, as tenant creation makes it.
    const ownerRole = await ownerDb().role.create({
      data: { tenantId, name: 'Owner', permissions: ['device.enroll', 'store.manage'], requiresMfa: true, isSystem: true },
    });
    const { user } = await createUser(tenantId, { email: 'owner@acme.lk', password: PW });
    await ownerDb().userRole.create({ data: { tenantId, userId: user.id, roleId: ownerRole.id } });
    ownerId = user.id;
    const secret = randomBytes(20);
    adminId = (await createSuperAdmin({ email: 'root@pos.lk', password: PW, totpSecret: secret })).id;
    admin = await loginSuperAdmin(app, 'root@pos.lk', PW, secret);
  });

  it('requires a real reason', async () => {
    await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason: 'because' }).expect(400);
  });

  it('issues a 30-minute token for the owner, visibly marked as impersonated', async () => {
    const res = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason }).expect(201);
    expect(res.body).toMatchObject({ expiresIn: 1800, host: 'acme.pos.localhost', userId: ownerId });
    const payload = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(1800);
    expect(payload.imp).toBe(adminId);

    const me = await http().get('/api/me').set('Host', hostFor('acme')).set(bearer(res.body.accessToken)).expect(200);
    expect(me.body).toMatchObject({ user: { id: ownerId }, impersonatedBy: adminId });
  });

  it('records the reason in both audit logs and tags actions taken while impersonating', async () => {
    const res = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason }).expect(201);
    const register = await createRegister(tenantId, (await createStore(tenantId)).id);
    await http().post('/api/devices/enrollments').set('Host', hostFor('acme')).set(bearer(res.body.accessToken)).send({ registerId: register.id }).expect(201);

    const started = await ownerDb().auditEvent.findFirstOrThrow({ where: { action: 'impersonation.started' } });
    expect(started).toMatchObject({ tenantId, impersonatorId: adminId, actorUserId: ownerId, after: { reason, sessionId: res.body.sessionId } });
    const action = await ownerDb().auditEvent.findFirstOrThrow({ where: { action: 'device.enrollment_created' } });
    expect(action).toMatchObject({ actorUserId: ownerId, impersonatorId: adminId });
    expect(await ownerDb().platformAuditEvent.count({ where: { action: 'tenant.impersonation_started' } })).toBe(1);
  });

  it('the token only works on that tenant', async () => {
    await createTenant({ slug: 'other' });
    const res = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason }).expect(201);
    await http().get('/api/me').set('Host', hostFor('other')).set(bearer(res.body.accessToken)).expect(403);
  });

  it('ending impersonation kills the token', async () => {
    const res = await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason }).expect(201);
    await asAdmin(http().post(`/api/platform/impersonations/${res.body.sessionId}/end`)).expect(204);
    await http().get('/api/me').set('Host', hostFor('acme')).set(bearer(res.body.accessToken)).expect(401);
  });

  it('refuses suspended tenants and unknown users', async () => {
    await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`))
      .send({ reason, userId: '0190b6a0-0000-7000-8000-000000000099' })
      .expect(404);
    await ownerDb().tenant.update({ where: { id: tenantId }, data: { status: 'SUSPENDED' } });
    await asAdmin(http().post(`/api/platform/tenants/${tenantId}/impersonate`)).send({ reason }).expect(409);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- test/impersonation.e2e.spec.ts`
Expected: FAIL — route 404.

- [ ] **Step 3: Implement**

`backend/src/modules/platform/impersonation.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { ImpersonateSchema } from '@pos/shared';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { ENV, type Env } from '../../config/env.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { RevocationStore } from '../../security/revocation.store.js';
import { TokenService } from '../../security/token.service.js';
import type { platformAuditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { OWNER_ROLE_NAME } from './tenants.service.js';

export const IMPERSONATION_TTL_SEC = 1800;
type Ctx = ReturnType<typeof platformAuditContext>;

@Injectable()
export class ImpersonationService {
  private readonly base: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantDb: TenantDb,
    private readonly tokens: TokenService,
    private readonly revocations: RevocationStore,
    private readonly audit: AuditService,
    @Inject(ENV) env: Env,
  ) {
    this.base = env.PLATFORM_DOMAIN;
  }

  async start(tenantId: string, input: z.infer<typeof ImpersonateSchema>, ctx: Ctx) {
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
    if (!tenant) throw AppError.notFound('Tenant not found');
    if (tenant.status !== 'ACTIVE') throw AppError.conflict('Reactivate the tenant before impersonating');

    const sessionId = uuidv7();
    const target = await this.tenantDb.run(tenantId, async (tx) => {
      const user = input.userId
        ? await tx.user.findFirst({ where: { id: input.userId, status: 'ACTIVE' } })
        : await tx.user.findFirst({
            where: { status: 'ACTIVE', roles: { some: { role: { name: OWNER_ROLE_NAME, isSystem: true } } } },
            orderBy: { createdAt: 'asc' },
          });
      if (!user) throw AppError.notFound('User not found');
      await this.audit.record(tx, tenantId, {
        ip: ctx.ip, userAgent: ctx.userAgent, correlationId: ctx.correlationId,
        action: 'impersonation.started', entityType: 'User', entityId: user.id,
        actorUserId: user.id, impersonatorId: ctx.actorId, after: { reason: input.reason, sessionId },
      });
      await this.audit.recordPlatform(tx, {
        ...ctx, action: 'tenant.impersonation_started', entityType: 'Tenant', entityId: tenantId,
        after: { reason: input.reason, userId: user.id, sessionId },
      });
      return user;
    });

    const accessToken = await this.tokens.sign(
      'tenant',
      { sub: target.id, tid: tenantId, sid: sessionId, imp: ctx.actorId },
      IMPERSONATION_TTL_SEC,
    );
    return { accessToken, expiresIn: IMPERSONATION_TTL_SEC, sessionId, host: `${tenant.slug}.${this.base}`, userId: target.id };
  }

  async end(sessionId: string, ctx: Ctx) {
    await this.revocations.markRevoked(sessionId, IMPERSONATION_TTL_SEC);
    await this.prisma.$transaction((tx) =>
      this.audit.recordPlatform(tx, { ...ctx, action: 'tenant.impersonation_ended', entityType: 'ImpersonationSession', entityId: sessionId }),
    );
  }
}
```

`backend/src/modules/platform/impersonation.controller.ts`:
```ts
import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ImpersonateSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Realm } from '../access/decorators.js';
import { platformAuditContext } from '../audit/audit-context.js';
import { ImpersonationService } from './impersonation.service.js';

@Realm('platform')
@Controller('platform')
export class ImpersonationController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @Post('tenants/:id/impersonate')
  start(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(ImpersonateSchema)) body: z.infer<typeof ImpersonateSchema>,
  ) {
    return this.impersonation.start(id, body, platformAuditContext(req));
  }

  @Post('impersonations/:sessionId/end')
  @HttpCode(204)
  async end(@Req() req: RequestWithContext, @Param('sessionId', new ParseUUIDPipe()) sessionId: string) {
    await this.impersonation.end(sessionId, platformAuditContext(req));
  }
}
```

`backend/src/modules/platform/platform.module.ts`: add the `ImpersonationController` / `ImpersonationService` imports and entries shown in Task 16's final version.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/platform backend/test/impersonation.e2e.spec.ts
git commit -m "feat(platform): time-boxed, reason-required, dual-audited impersonation"
```

---

### Task 18: Back-office API — stores, registers, roles, users, audit view

**Files:**
- Create: `backend/src/modules/backoffice/grant-rules.ts`
- Create: `backend/src/modules/backoffice/org.service.ts`, `backend/src/modules/backoffice/stores.controller.ts`, `backend/src/modules/backoffice/registers.controller.ts`
- Create: `backend/src/modules/backoffice/roles.service.ts`, `backend/src/modules/backoffice/roles.controller.ts`
- Create: `backend/src/modules/backoffice/users.service.ts`, `backend/src/modules/backoffice/users.controller.ts`
- Create: `backend/src/modules/backoffice/audit.controller.ts`
- Modify: `backend/src/modules/backoffice/backoffice.module.ts`
- Test: `backend/src/modules/backoffice/grant-rules.spec.ts`, `backend/test/backoffice.e2e.spec.ts`

**Interfaces:**
- Consumes: `CreateStoreSchema`, `CreateRegisterSchema`, `CreateRoleSchema`, `CreateUserSchema`, `SetPinSchema`; `CapabilitiesService.permissionsFor`, `PlanLimitsService`, `PasswordService`, `AuditService`, `auditContext`.
- Produces:
  - `assertCanGrant(actor: Set<Permission>, requested: Iterable<string>): void` — throws `403 FORBIDDEN` with `details: { missing: string[] }`.
  - Routes (tenant host):
    - `POST /api/stores` (`store.manage`), `GET /api/stores` (`store.manage`)
    - `POST /api/registers` (`register.manage`), `GET /api/registers` (`register.manage`)
    - `POST /api/roles` (`role.manage`), `GET /api/roles` (`role.manage`)
    - `POST /api/users` (`user.manage`) → `{ user, setupCode: string | null }`, `GET /api/users` (`user.manage`, never returns hashes), `PUT /api/users/:id/pin` (`user.manage`, 204)
    - `GET /api/users/pin-pad` (public, device-signed) → `[{ id, name }]` of active users with a PIN
    - `GET /api/audit?limit=` (`audit.view`, newest first, `seq` as string), `GET /api/audit/verify` (`audit.view`)
  - Escalation rules: a role can only contain permissions the creator holds; a user can only be given roles whose permissions the creator holds; a PIN can only be set for a user whose permissions the actor holds.

- [ ] **Step 1: Write the failing tests**

`backend/src/modules/backoffice/grant-rules.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Permission } from '@pos/shared';
import { assertCanGrant } from './grant-rules.js';

describe('assertCanGrant', () => {
  const actor = new Set<Permission>(['sale.create', 'role.manage']);
  it('allows a subset', () => {
    expect(() => assertCanGrant(actor, ['sale.create'])).not.toThrow();
    expect(() => assertCanGrant(actor, [])).not.toThrow();
  });
  it('refuses anything the actor lacks and names it', () => {
    try {
      assertCanGrant(actor, ['sale.create', 'sale.refund', 'sale.refund']);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ status: 403, code: 'FORBIDDEN', details: { missing: ['sale.refund'] } });
    }
  });
});
```

`backend/test/backoffice.e2e.spec.ts`:
```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PERMISSIONS } from '@pos/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { enrollTestDevice, signedHeaders } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';

describe('back-office', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const host = hostFor('acme');
  let tenantId: string;
  let owner: string;
  let ownerUserId: string;
  const asOwner = (r: request.Test) => r.set('Host', host).set(bearer(owner));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    tenantId = (await createTenant({ slug: 'acme', maxStores: 1 })).id;
    ownerUserId = (await createUser(tenantId, { email: 'owner@acme.lk', password: PW, permissions: [...PERMISSIONS] })).user.id;
    owner = await loginPassword(app, 'acme', 'owner@acme.lk', PW);
  });

  describe('stores and registers', () => {
    it('creates and lists, within the plan limit', async () => {
      const store = await asOwner(http().post('/api/stores')).send({ name: 'Colombo 03', code: 'COL3' }).expect(201);
      await asOwner(http().post('/api/stores')).send({ name: 'Kandy', code: 'KDY' }).expect(403);
      const reg = await asOwner(http().post('/api/registers')).send({ storeId: store.body.id, name: 'Till 1', code: 'T1' }).expect(201);
      expect(reg.body).toMatchObject({ storeId: store.body.id, code: 'T1' });
      expect((await asOwner(http().get('/api/stores')).expect(200)).body).toHaveLength(1);
      expect((await asOwner(http().get('/api/registers')).expect(200)).body).toHaveLength(1);
    });

    it('duplicate store codes conflict', async () => {
      await ownerDb().plan.updateMany({ data: { maxStores: 5 } });
      await asOwner(http().post('/api/stores')).send({ name: 'A', code: 'AAA' }).expect(201);
      await asOwner(http().post('/api/stores')).send({ name: 'B', code: 'AAA' }).expect(409);
    });

    it("refuses a register on another tenant's store", async () => {
      const other = await createTenant({ slug: 'other' });
      const foreign = await createStore(other.id);
      await asOwner(http().post('/api/registers')).send({ storeId: foreign.id, name: 'Till', code: 'T9' }).expect(404);
    });
  });

  describe('privilege escalation', () => {
    let manager: string;
    let cashierUserId: string;
    beforeEach(async () => {
      await createUser(tenantId, { email: 'mgr@acme.lk', password: PW, permissions: ['role.manage', 'user.manage', 'sale.create'] });
      manager = await loginPassword(app, 'acme', 'mgr@acme.lk', PW);
      cashierUserId = (await createUser(tenantId, { name: 'Cashier', permissions: ['sale.create'] })).user.id;
    });
    const asManager = (r: request.Test) => r.set('Host', host).set(bearer(manager));

    it('cannot create a role with a permission they lack', async () => {
      const res = await asManager(http().post('/api/roles')).send({ name: 'Refunder', permissions: ['sale.create', 'sale.refund'] }).expect(403);
      expect(res.body.details).toEqual({ missing: ['sale.refund'] });
      await asManager(http().post('/api/roles')).send({ name: 'Seller', permissions: ['sale.create'] }).expect(201);
    });

    it('cannot assign a role carrying a permission they lack', async () => {
      const refunder = await asOwner(http().post('/api/roles')).send({ name: 'Refunder', permissions: ['sale.refund'] }).expect(201);
      await asManager(http().post('/api/users')).send({ name: 'New', roleIds: [refunder.body.id], pin: '4321' }).expect(403);
    });

    it("cannot set the PIN of someone more privileged, can for someone they cover", async () => {
      await asManager(http().put(`/api/users/${ownerUserId}/pin`)).send({ pin: '1111' }).expect(403);
      await asManager(http().put(`/api/users/${cashierUserId}/pin`)).send({ pin: '1111' }).expect(204);
    });

    it('cannot create the reserved Owner role', async () => {
      await asOwner(http().post('/api/roles')).send({ name: 'owner', permissions: [] }).expect(400);
    });
  });

  describe('users', () => {
    it('creates a user with a one-time setup code and never exposes hashes', async () => {
      const role = await asOwner(http().post('/api/roles')).send({ name: 'Supervisor', permissions: ['sale.void'], requiresMfa: false }).expect(201);
      const created = await asOwner(http().post('/api/users')).send({ name: 'Nimal', email: 'Nimal@acme.lk', roleIds: [role.body.id], pin: '2468' }).expect(201);
      expect(created.body.setupCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(created.body.user).toEqual({ id: expect.any(String), name: 'Nimal', email: 'nimal@acme.lk', status: 'ACTIVE', roles: [{ id: role.body.id, name: 'Supervisor' }], hasPin: true });

      await http().post('/api/auth/setup-password').set('Host', host).send({ code: created.body.setupCode, password: PW }).expect(204);
      await loginPassword(app, 'acme', 'nimal@acme.lk', PW);

      const list = await asOwner(http().get('/api/users')).expect(200);
      const text = JSON.stringify(list.body);
      expect(text).not.toMatch(/argon2|Hash|totp/i);
      expect(list.body).toHaveLength(2);
    });

    it('refuses unknown role ids', async () => {
      await asOwner(http().post('/api/users')).send({ name: 'X', roleIds: ['0190b6a0-0000-7000-8000-000000000099'] }).expect(404);
    });

    it('serves the PIN pad to enrolled devices only', async () => {
      await createUser(tenantId, { name: 'With PIN', pin: '1357' });
      await createUser(tenantId, { name: 'No PIN' });
      const register = await createRegister(tenantId, (await createStore(tenantId)).id);
      const device = await enrollTestDevice(tenantId, register.id, ownerUserId);
      await http().get('/api/users/pin-pad').set('Host', host).expect(401);
      const res = await http().get('/api/users/pin-pad').set('Host', host).set(await signedHeaders(device, 'GET', '/api/users/pin-pad')).expect(200);
      expect(res.body.map((u: { name: string }) => u.name)).toEqual(['With PIN']);
    });
  });

  describe('audit view', () => {
    it('lists recent events and verifies the chain', async () => {
      await asOwner(http().post('/api/stores')).send({ name: 'Colombo 03', code: 'COL3' }).expect(201);
      const list = await asOwner(http().get('/api/audit?limit=10')).expect(200);
      expect(list.body[0]).toMatchObject({ action: 'store.created', seq: expect.stringMatching(/^\d+$/) });
      expect((await asOwner(http().get('/api/audit/verify')).expect(200)).body).toMatchObject({ ok: true });
    });

    it('requires audit.view', async () => {
      await createUser(tenantId, { email: 'c@acme.lk', password: PW, permissions: ['sale.create'] });
      const cashier = await loginPassword(app, 'acme', 'c@acme.lk', PW);
      await http().get('/api/audit').set('Host', host).set(bearer(cashier)).expect(403);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend -- backoffice grant-rules`
Expected: FAIL — `grant-rules.js` not found; `/api/stores` 404.

- [ ] **Step 3: Implement**

`backend/src/modules/backoffice/grant-rules.ts`:
```ts
import type { Permission } from '@pos/shared';
import { AppError } from '../../common/errors/app-error.js';

/** You can only hand out authority you hold yourself. */
export function assertCanGrant(actor: Set<Permission>, requested: Iterable<string>): void {
  const missing = [...new Set(requested)].filter((p) => !actor.has(p as Permission));
  if (missing.length) throw new AppError('FORBIDDEN', 403, 'You cannot grant permissions you do not hold', { missing });
}
```

`backend/src/modules/backoffice/org.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { CreateRegisterSchema, CreateStoreSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { PlanLimitsService } from '../access/plan-limits.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

type Ctx = ReturnType<typeof auditContext>;

@Injectable()
export class OrgService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly limits: PlanLimitsService,
    private readonly audit: AuditService,
  ) {}

  createStore(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof CreateStoreSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      await this.limits.assertCanAdd(tx, tenant, 'stores');
      const store = await tx.store.create({ data: { tenantId: tenant.id, ...input } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'store.created', entityType: 'Store', entityId: store.id, after: input });
      return store;
    });
  }

  listStores(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) => tx.store.findMany({ orderBy: { code: 'asc' } }));
  }

  createRegister(tenant: TenantContext, ctx: Ctx, input: z.infer<typeof CreateRegisterSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      const store = await tx.store.findUnique({ where: { id: input.storeId } });
      if (!store) throw AppError.notFound('Store not found');
      const register = await tx.register.create({ data: { tenantId: tenant.id, ...input } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'register.created', entityType: 'Register', entityId: register.id, after: input });
      return register;
    });
  }

  listRegisters(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) => tx.register.findMany({ orderBy: { code: 'asc' } }));
  }
}
```

`backend/src/modules/backoffice/stores.controller.ts`:
```ts
import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { CreateStoreSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { OrgService } from './org.service.js';

@Controller('stores')
export class StoresController {
  constructor(private readonly org: OrgService) {}

  @RequiresPermission('store.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateStoreSchema)) body: z.infer<typeof CreateStoreSchema>) {
    return this.org.createStore(req.tenant!, auditContext(req), body);
  }

  @RequiresPermission('store.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.org.listStores(req.tenant!);
  }
}
```

`backend/src/modules/backoffice/registers.controller.ts`:
```ts
import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { CreateRegisterSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { OrgService } from './org.service.js';

@Controller('registers')
export class RegistersController {
  constructor(private readonly org: OrgService) {}

  @RequiresPermission('register.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateRegisterSchema)) body: z.infer<typeof CreateRegisterSchema>) {
    return this.org.createRegister(req.tenant!, auditContext(req), body);
  }

  @RequiresPermission('register.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.org.listRegisters(req.tenant!);
  }
}
```

`backend/src/modules/backoffice/roles.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { CreateRoleSchema } from '@pos/shared';
import type { z } from 'zod';
import type { Principal, TenantContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { assertCanGrant } from './grant-rules.js';

type Ctx = ReturnType<typeof auditContext>;

@Injectable()
export class RolesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly capabilities: CapabilitiesService,
    private readonly audit: AuditService,
  ) {}

  async create(tenant: TenantContext, principal: Principal, ctx: Ctx, input: z.infer<typeof CreateRoleSchema>) {
    assertCanGrant(await this.capabilities.permissionsFor(tenant.id, principal.userId), input.permissions);
    return this.tenantDb.run(tenant.id, async (tx) => {
      const role = await tx.role.create({ data: { tenantId: tenant.id, ...input, isSystem: false } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'role.created', entityType: 'Role', entityId: role.id, after: input });
      return role;
    });
  }

  list(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.role.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, permissions: true, requiresMfa: true, isSystem: true, _count: { select: { users: true } } },
      }),
    );
  }
}
```

`backend/src/modules/backoffice/roles.controller.ts`:
```ts
import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { CreateRoleSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { RolesService } from './roles.service.js';

@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequiresPermission('role.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateRoleSchema)) body: z.infer<typeof CreateRoleSchema>) {
    return this.roles.create(req.tenant!, req.principal!, auditContext(req), body);
  }

  @RequiresPermission('role.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.roles.list(req.tenant!);
  }
}
```

`backend/src/modules/backoffice/users.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { CreateUserSchema } from '@pos/shared';
import type { z } from 'zod';
import { randomToken, sha256Hex } from '../../common/crypto/hash.js';
import { AppError } from '../../common/errors/app-error.js';
import type { Principal, TenantContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { PasswordService } from '../../security/password.service.js';
import { CapabilitiesService } from '../access/capabilities.service.js';
import { PlanLimitsService } from '../access/plan-limits.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';
import { assertCanGrant } from './grant-rules.js';

const USER_SETUP_TTL_MS = 7 * 24 * 3_600_000;
type Ctx = ReturnType<typeof auditContext>;

const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  status: true,
  pinHash: true,
  roles: { select: { role: { select: { id: true, name: true } } } },
} as const;

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  status: string;
  pinHash: string | null;
  roles: { role: { id: string; name: string } }[];
};

/** The only shape a user leaves the API in: no hashes, no secrets. */
const toPublicUser = (u: UserRow) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  status: u.status,
  roles: u.roles.map((r) => r.role),
  hasPin: u.pinHash !== null,
});

@Injectable()
export class UsersService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly capabilities: CapabilitiesService,
    private readonly limits: PlanLimitsService,
    private readonly audit: AuditService,
  ) {}

  async create(tenant: TenantContext, principal: Principal, ctx: Ctx, input: z.infer<typeof CreateUserSchema>) {
    const actor = await this.capabilities.permissionsFor(tenant.id, principal.userId);
    const pinHash = input.pin ? await this.passwords.hash(input.pin) : null;
    const setupCode = input.email ? randomToken(24) : null;
    return this.tenantDb.run(tenant.id, async (tx) => {
      await this.limits.assertCanAdd(tx, tenant, 'users');
      const roleIds = [...new Set(input.roleIds)];
      const roles = await tx.role.findMany({ where: { id: { in: roleIds } } });
      if (roles.length !== roleIds.length) throw AppError.notFound('Role not found');
      assertCanGrant(actor, roles.flatMap((r) => r.permissions));
      const created = await tx.user.create({
        data: {
          tenantId: tenant.id,
          name: input.name,
          email: input.email ?? null,
          pinHash,
          setupTokenHash: setupCode ? sha256Hex(setupCode) : null,
          setupTokenExpiresAt: setupCode ? new Date(Date.now() + USER_SETUP_TTL_MS) : null,
        },
      });
      await tx.userRole.createMany({ data: roles.map((r) => ({ tenantId: tenant.id, userId: created.id, roleId: r.id })) });
      await this.audit.record(tx, tenant.id, {
        ...ctx,
        action: 'user.created',
        entityType: 'User',
        entityId: created.id,
        after: { name: input.name, email: input.email ?? null, roleIds, hasPin: pinHash !== null },
      });
      const user = await tx.user.findUniqueOrThrow({ where: { id: created.id }, select: publicUserSelect });
      return { user: toPublicUser(user), setupCode };
    });
  }

  async list(tenant: TenantContext) {
    const users = await this.tenantDb.run(tenant.id, (tx) => tx.user.findMany({ orderBy: { name: 'asc' }, select: publicUserSelect }));
    return users.map(toPublicUser);
  }

  async setPin(tenant: TenantContext, principal: Principal, ctx: Ctx, userId: string, pin: string) {
    const actor = await this.capabilities.permissionsFor(tenant.id, principal.userId);
    const pinHash = await this.passwords.hash(pin);
    await this.tenantDb.run(tenant.id, async (tx) => {
      const target = await tx.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
      if (!target) throw AppError.notFound('User not found');
      // Setting someone's PIN lets you sign in as them on a till: same rule as granting their roles.
      assertCanGrant(actor, target.roles.flatMap((r) => r.role.permissions));
      await tx.user.update({ where: { id: userId }, data: { pinHash, pinFailedCount: 0, pinLockedUntil: null } });
      await this.audit.record(tx, tenant.id, { ...ctx, action: 'user.pin_set', entityType: 'User', entityId: userId });
    });
  }

  pinPad(tenant: TenantContext) {
    return this.tenantDb.run(tenant.id, (tx) =>
      tx.user.findMany({ where: { status: 'ACTIVE', pinHash: { not: null } }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    );
  }
}
```

`backend/src/modules/backoffice/users.controller.ts`:
```ts
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { CreateUserSchema, SetPinSchema } from '@pos/shared';
import type { z } from 'zod';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Public, RequiresDevice, RequiresPermission } from '../access/decorators.js';
import { auditContext } from '../audit/audit-context.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequiresPermission('user.manage')
  @Post()
  create(@Req() req: RequestWithContext, @Body(new ZodPipe(CreateUserSchema)) body: z.infer<typeof CreateUserSchema>) {
    return this.users.create(req.tenant!, req.principal!, auditContext(req), body);
  }

  @RequiresPermission('user.manage')
  @Get()
  list(@Req() req: RequestWithContext) {
    return this.users.list(req.tenant!);
  }

  /** Names for the till's PIN screen. Enrolled devices only; no user session needed. */
  @Public()
  @RequiresDevice()
  @Get('pin-pad')
  pinPad(@Req() req: RequestWithContext) {
    return this.users.pinPad(req.tenant!);
  }

  @RequiresPermission('user.manage')
  @Put(':id/pin')
  @HttpCode(204)
  async setPin(
    @Req() req: RequestWithContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(SetPinSchema)) body: z.infer<typeof SetPinSchema>,
  ) {
    await this.users.setPin(req.tenant!, req.principal!, auditContext(req), id, body.pin);
  }
}
```

`backend/src/modules/backoffice/audit.controller.ts`:
```ts
import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, Req } from '@nestjs/common';
import type { RequestWithContext } from '../../common/request-context.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import { RequiresPermission } from '../access/decorators.js';
import { AuditService } from '../audit/audit.service.js';

@Controller('audit')
export class AuditController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  @RequiresPermission('audit.view')
  @Get()
  async list(@Req() req: RequestWithContext, @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number) {
    const take = Math.min(Math.max(limit, 1), 200);
    const rows = await this.tenantDb.run(req.tenant!.id, (tx) => tx.auditEvent.findMany({ orderBy: { seq: 'desc' }, take }));
    return rows.map(({ seq, ...rest }) => ({ ...rest, seq: seq.toString() }));
  }

  @RequiresPermission('audit.view')
  @Get('verify')
  verify(@Req() req: RequestWithContext) {
    return this.tenantDb.run(req.tenant!.id, (tx) => this.audit.verifyTenantChain(tx, req.tenant!.id));
  }
}
```

`backend/src/modules/backoffice/backoffice.module.ts` (replace):
```ts
import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { MeController } from './me.controller.js';
import { OrgService } from './org.service.js';
import { RegistersController } from './registers.controller.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { StoresController } from './stores.controller.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [MeController, StoresController, RegistersController, RolesController, UsersController, AuditController],
  providers: [OrgService, RolesService, UsersService],
})
export class BackofficeModule {}
```

Route-order note: `GET /api/users/pin-pad` is declared before `PUT /api/users/:id/pin` and uses a different method, so it is never captured by `:id`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/backoffice backend/test/backoffice.e2e.spec.ts
git commit -m "feat(backoffice): stores, registers, roles, users, audit view with no-escalation grant rules"
```

---

### Task 19: Cross-tenant leakage suite, README, full verification

**Files:**
- Create: `backend/test/leakage.e2e.spec.ts`
- Modify: `README.md` (replace)

**Interfaces:**
- Consumes: every tenant-host endpoint from Tasks 9–18.
- Produces: an end-to-end proof that tenant A, with full permissions, cannot read, reference, or modify any of tenant B's data through the API; run instructions.

- [ ] **Step 1: Write the leakage suite**

`backend/test/leakage.e2e.spec.ts`:
```ts
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PERMISSIONS } from '@pos/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';
import { ownerDb, resetDb } from './helpers/db.js';
import { enrollTestDevice, signedHeaders, type TestDevice } from './helpers/device.js';
import { createRegister, createStore, createTenant, createUser, hostFor } from './helpers/fixtures.js';
import { bearer, loginPassword } from './helpers/http.js';
import { flushRedis } from './helpers/redis.js';

const PW = 'correct horse battery staple';
const LIST_ENDPOINTS = ['/api/stores', '/api/registers', '/api/users', '/api/roles', '/api/devices', '/api/audit'];

interface World {
  tenantId: string;
  token: string;
  storeId: string;
  registerId: string;
  roleId: string;
  userId: string;
  device: TestDevice;
  ids: Set<string>;
}

async function buildTenant(app: NestExpressApplication, slug: string): Promise<World> {
  const tenantId = (await createTenant({ slug, maxStores: 5 })).id;
  const owner = await createUser(tenantId, { email: `owner@${slug}.lk`, password: PW, permissions: [...PERMISSIONS] });
  const staff = await createUser(tenantId, { name: 'Staff', pin: '2468', permissions: ['sale.create'] });
  const store = await createStore(tenantId);
  const register = await createRegister(tenantId, store.id);
  const device = await enrollTestDevice(tenantId, register.id, owner.user.id);
  const token = await loginPassword(app, slug, `owner@${slug}.lk`, PW); // also writes an audit event
  const audit = await ownerDb().auditEvent.findMany({ where: { tenantId }, select: { id: true } });
  const ids = new Set([
    tenantId, owner.user.id, owner.role.id, staff.user.id, staff.role.id, store.id, register.id, device.id, ...audit.map((a) => a.id),
  ]);
  return { tenantId, token, storeId: store.id, registerId: register.id, roleId: staff.role.id, userId: staff.user.id, device, ids };
}

describe('cross-tenant isolation through the API', () => {
  let app: NestExpressApplication;
  let a: World;
  let b: World;
  const http = () => request(app.getHttpServer());
  const asA = (r: request.Test) => r.set('Host', hostFor('alpha')).set(bearer(a.token));

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb();
    await flushRedis();
    a = await buildTenant(app, 'alpha');
    b = await buildTenant(app, 'bravo');
  });

  it.each(LIST_ENDPOINTS)('GET %s on A never returns B ids', async (path) => {
    const res = await asA(http().get(path)).expect(200);
    const text = JSON.stringify(res.body);
    for (const id of b.ids) expect(text).not.toContain(id);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it.each(LIST_ENDPOINTS)("A's token on B's host is refused for %s", async (path) => {
    const res = await http().get(path).set('Host', hostFor('bravo')).set(bearer(a.token)).expect(403);
    expect(res.body.code).toBe('TENANT_MISMATCH');
  });

  it('A cannot reference B rows in writes', async () => {
    await asA(http().post('/api/registers')).send({ storeId: b.storeId, name: 'x', code: 'X1' }).expect(404);
    await asA(http().post('/api/users')).send({ name: 'x', roleIds: [b.roleId] }).expect(404);
    await asA(http().post('/api/devices/enrollments')).send({ registerId: b.registerId }).expect(404);
  });

  it('A cannot modify B rows by id', async () => {
    await asA(http().post(`/api/devices/${b.device.id}/revoke`)).expect(404);
    await asA(http().put(`/api/users/${b.userId}/pin`)).send({ pin: '0000' }).expect(404);
    const device = await ownerDb().device.findUniqueOrThrow({ where: { id: b.device.id } });
    expect(device.revokedAt).toBeNull();
    const staff = await ownerDb().user.findUniqueOrThrow({ where: { id: b.userId } });
    expect(staff.pinFailedCount).toBe(0);
  });

  it("B's device cannot act on A's host", async () => {
    const path = '/api/users/pin-pad';
    await http().get(path).set('Host', hostFor('alpha')).set(await signedHeaders(b.device, 'GET', path)).expect(401);
  });

  it("A's audit chain and B's audit chain verify independently", async () => {
    expect((await asA(http().get('/api/audit/verify')).expect(200)).body).toMatchObject({ ok: true });
    const resB = await http().get('/api/audit/verify').set('Host', hostFor('bravo')).set(bearer(b.token)).expect(200);
    expect(resB.body).toMatchObject({ ok: true });
  });
});
```

- [ ] **Step 2: Run the suite**

Run: `npm test -w backend -- test/leakage.e2e.spec.ts`
Expected: PASS (it exercises code from earlier tasks; a failure here is a real isolation bug — fix the code, not the test).

- [ ] **Step 3: Replace `README.md`**

```markdown
# POS Platform

Multi-tenant, zero-trust point-of-sale SaaS. Design: `docs/superpowers/specs/2026-11-02-pos-platform-design.md`.

## Layout

| Folder | What |
|---|---|
| `backend/` | NestJS 12 API (ESM), Prisma 7, PostgreSQL 16 with row-level security |
| `shared/` | Types, Zod schemas, module and permission registries shared by API and apps |
| `frontend/` | Angular workspace (Plan 1b) |
| `infra/` | Docker Compose: Postgres, Redis, Caddy edge |
| `docs/` | Specs and implementation plans |

## Run it locally

Requires Node ≥ 22 and Docker.

    npm install
    npm run infra:up                       # postgres + redis
    npm run env:dev -w backend             # writes backend/.env with fresh keys (once)
    npm run build:shared
    npm run prisma:generate -w backend     # generates backend/src/generated/prisma (git-ignored)
    cd backend && npx prisma migrate deploy && cd ..
    npm run db:seed -w backend             # plan "standard" + retail/cafe/grocery/pharmacy
    npm run platform:create-admin -w backend -- --email you@example.com --name "Your Name"
    npm run dev:api                        # http://localhost:3000/api/health

Hosts: the super-admin API answers on `admin.pos.localhost`, tenants on `<slug>.pos.localhost`
(send the `Host` header, or run the Caddy edge: `docker compose -f infra/docker-compose.yml --profile edge up -d caddy`).

## Test

    npm test            # shared + backend (needs infra:up)

The backend suite runs against the `pos_test` database and Redis DB 1. Notable suites:
`rls.spec.ts` (database-level isolation and the "every tenantId table has RLS" guard),
`leakage.e2e.spec.ts` (API-level cross-tenant isolation), `audit.spec.ts` (tamper-evident log).

## Security model in one paragraph

Every request resolves its tenant from the Host header, then passes one guard chain: realm →
tenant status → user token (EdDSA, 5 min) → device signature (ECDSA P-256, nonce + clock skew)
→ module enabled → permission → manager step-up. Tenant data is only reachable inside
`TenantDb.run`, which sets a transaction-local `app.tenant_id`; Postgres RLS filters everything
else, and composite `(tenantId, id)` foreign keys stop cross-tenant references. Every sensitive
action lands in a per-tenant hash-chained audit log the app role cannot update or delete.

## Adding a tenant-scoped table

1. Give it `tenantId` and `@@unique([tenantId, id])`; relate to other tenant tables with composite keys.
2. Add it to an RLS block in a new migration (copy `prisma/migrations/*_rls/migration.sql`).
3. `rls.spec.ts` fails until you do.
```

- [ ] **Step 4: Full verification**

Run, in order, and confirm each:
```bash
npm test                                   # all shared + backend suites PASS
npm run build -w backend                   # tsc emits backend/dist with no errors
npm run dev:api                            # in a second terminal
curl -s http://localhost:3000/api/health          # {"status":"ok"}
curl -s http://localhost:3000/api/health/ready    # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: admin.pos.localhost" http://localhost:3000/api/platform/tenants   # 401
```

- [ ] **Step 5: Commit**

```bash
git add backend/test/leakage.e2e.spec.ts README.md
git commit -m "test: API-level cross-tenant leakage suite; docs: README with run and security notes"
```

---

## Deferred to later plans (explicitly out of scope here)

- **Plan 1b:** the Angular workspace (`frontend/projects/{admin,pos,ui}`): super-admin console, tenant back-office, device enrollment screen.
- **Milestone 2:** hardware-bridge pairing (spec §8), catalog, tax engine, checkout. The bridge pairing reuses the device public key enrolled here.
- **Milestone 3:** offline encrypted IndexedDB and hash-chained offline sales (spec §4.4, §7). The device-signing payload in `shared/` is the same one the PWA will use.
- **Tenant purge job:** soft-deleted tenants are kept; the 30-day purge (spec §5) ships with tenant billing in Milestone 7.
- **Platform RBAC:** all super admins are equal in this plan; per-admin platform roles come with Plan 1b's console.
- **Email delivery:** setup codes are returned once by the API or printed once by the CLI; no mail is sent.
- **Customer PII field encryption** (spec §4.5): there are no customer tables until Milestone 4; `Aead` from Task 6 is the primitive they will use.
- **Plan limits under concurrency:** limits are checked inside the creating transaction but not serialised; two simultaneous creates can exceed a limit by one. Acceptable for M1; revisit with billing.
- **Production edge:** the Caddyfile here is local-dev only (internal CA).
- **WebAuthn** (spec §4.1 offers "TOTP or WebAuthn"): TOTP only in this plan; WebAuthn needs the browser flows from Plan 1b.
- **Step-up thresholds** (spec §4.3 "refund > X, discount > Y%"): the step-up mechanism is built and tested here; the per-tenant threshold settings attach to sales routes in Milestone 2.
- **Custom fields** (spec §5): `CustomFieldDefinition` lands with the catalog in Milestone 2, when products exist to carry them.
- **Structured JSON logging and error capture** (spec §9): Nest's default logger here; pino + a Sentry-compatible hook are added with deployment work.
- **CSP for the Angular apps** (spec §4.5): set by the frontend server config in Plan 1b. Helmet's defaults (including HSTS) already apply to the API.
