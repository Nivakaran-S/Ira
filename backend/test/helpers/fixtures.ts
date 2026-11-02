import { v7 as uuidv7 } from 'uuid';
import { ownerDb } from './db.js';
import type { Permission } from '@pos/shared';
import { Aead } from '../../src/common/crypto/aead.js';
import { sha256Hex } from '../../src/common/crypto/hash.js';
import { PasswordService } from '../../src/security/password.service.js';

export const PLATFORM_DOMAIN = 'pos.localhost';
export const ADMIN_HOST = `admin.${PLATFORM_DOMAIN}`;
export const hostFor = (slug: string) => `${slug}.${PLATFORM_DOMAIN}`;

export async function createPlan(overrides: { maxStores?: number; maxDevices?: number; maxUsers?: number } = {}) {
  return ownerDb().plan.create({
    data: {
      key: `plan-${uuidv7()}`,
      name: 'Test plan',
      maxStores: overrides.maxStores ?? 3,
      maxDevices: overrides.maxDevices ?? 10,
      maxUsers: overrides.maxUsers ?? 25,
    },
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
