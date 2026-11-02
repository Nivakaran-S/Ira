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
