import { v7 as uuidv7 } from 'uuid';
import { ownerDb } from './db.js';

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
