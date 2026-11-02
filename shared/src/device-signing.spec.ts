import { describe, expect, it } from 'vitest';
import { buildSigningPayload } from './device-signing.js';

describe('buildSigningPayload', () => {
  it('joins upper-cased method, path, body hash, ts and nonce with newlines', () => {
    expect(buildSigningPayload('post', '/api/auth/pin?x=1', 'abc', '1700000000', 'n1')).toBe(
      'POST\n/api/auth/pin?x=1\nabc\n1700000000\nn1',
    );
  });
});
