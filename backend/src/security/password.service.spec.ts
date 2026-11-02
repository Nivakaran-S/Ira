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
