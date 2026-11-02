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
