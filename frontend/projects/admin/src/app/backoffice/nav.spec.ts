import { describe, expect, it } from 'vitest';
import { navItems } from './nav';

describe('navItems', () => {
  it('shows only sections the user holds a permission for', () => {
    expect(navItems(new Set(['store.manage'])).map((n) => n.path)).toEqual(['/', '/stores']);
  });

  it('shows devices for either enroll or revoke', () => {
    expect(navItems(new Set(['device.revoke'])).map((n) => n.path)).toContain('/devices');
  });

  it('shows everything to an owner', () => {
    const all = new Set(['store.manage', 'register.manage', 'role.manage', 'user.manage', 'device.enroll', 'audit.view']);
    expect(navItems(all).map((n) => n.label)).toEqual(['Overview', 'Stores', 'Registers', 'Roles', 'Users', 'Devices', 'Audit log']);
  });
});
