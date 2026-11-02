import { randomUUID, webcrypto } from 'node:crypto';
import { buildSigningPayload } from '@pos/shared';
import { sha256Hex } from '../../src/common/crypto/hash.js';
import { ownerDb } from './db.js';

type Key = webcrypto.CryptoKey;
export interface TestDevice {
  id: string;
  privateKey: Key;
  publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

export async function createDeviceKeys() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, publicKeyJwk: { kty: 'EC' as const, crv: 'P-256' as const, x: jwk.x!, y: jwk.y! } };
}

/** Headers a till would send. `body` must be exactly what supertest will .send(). */
export async function signedHeaders(
  device: { id: string; privateKey: Key },
  method: string,
  path: string,
  body?: unknown,
  opts: { ts?: number; nonce?: string } = {},
): Promise<Record<string, string>> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomUUID();
  const payload = buildSigningPayload(method, path, sha256Hex(raw), ts, nonce);
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, new TextEncoder().encode(payload));
  return { 'x-device-id': device.id, 'x-device-ts': ts, 'x-device-nonce': nonce, 'x-device-sig': Buffer.from(sig).toString('base64url') };
}

/** Enrols directly in the DB, skipping the enrollment-code flow. */
export async function enrollTestDevice(tenantId: string, registerId: string, enrolledById: string): Promise<TestDevice> {
  const keys = await createDeviceKeys();
  const device = await ownerDb().device.create({
    data: { tenantId, registerId, name: 'Test till', publicKeyJwk: keys.publicKeyJwk, enrolledById },
  });
  return { id: device.id, ...keys };
}
