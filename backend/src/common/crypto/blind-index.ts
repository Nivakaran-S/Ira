import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Deterministic HMAC of a normalised value, so encrypted fields (phone, email) can be found by exact
 * match without storing them in the clear. The key is derived from the PII key, never stored.
 */
export class BlindIndex {
  private readonly key: Buffer;

  constructor(piiKey: Buffer) {
    this.key = Buffer.from(hkdfSync('sha256', piiKey, Buffer.alloc(0), 'pos-blind-index-v1', 32));
  }

  of(normalised: string): string {
    return createHmac('sha256', this.key).update(normalised).digest('base64url');
  }
}
