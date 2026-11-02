import { webcrypto } from 'node:crypto';

export interface DevicePublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** Throws if the JWK is not a valid P-256 public point. */
export function importDeviceKey(jwk: DevicePublicJwk) {
  return webcrypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

export async function verifyDeviceSignature(jwk: DevicePublicJwk, payload: string, sigB64Url: string): Promise<boolean> {
  try {
    const key = await importDeviceKey(jwk);
    return await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Buffer.from(sigB64Url, 'base64url'),
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}
