import { webcrypto } from 'node:crypto';
import { GENESIS, type OfflineOp, opHash } from '@pos/shared';
import type { TestDevice } from './device.js';

/** A till's offline outbox: builds hash-chained, device-signed ops. */
export class Outbox {
  seq = 0;
  prev = GENESIS;
  constructor(private readonly device: TestDevice) {}

  async op(kind: OfflineOp['kind'], payload: unknown, createdAt = new Date()): Promise<OfflineOp> {
    const base = { kind, seq: ++this.seq, prevHash: this.prev, createdAt: createdAt.toISOString(), payload } as unknown as OfflineOp;
    const hash = await opHash(base);
    const sig = Buffer.from(
      await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.device.privateKey, new TextEncoder().encode(hash)),
    ).toString('base64url');
    this.prev = hash;
    return { ...base, hash, sig } as OfflineOp;
  }
}
