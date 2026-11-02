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
