import { buildSigningPayload, DEVICE_HEADERS } from '@pos/shared';

export interface DevicePublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** A fresh device key pair. The private key is non-extractable: script can sign with it, never read it. */
export async function generateDeviceKeys() {
  const pair = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicKeyJwk: DevicePublicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyJwk };
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function nonce(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18))).replace(/_/g, '-');
}

/**
 * The four x-device-* headers for one request. `pathWithQuery` and `body` must be exactly what is
 * sent: the API rebuilds the payload from its own view of the request. WebCrypto's ECDSA output is
 * already IEEE P1363 (r || s), which is what the API verifies.
 */
export async function signRequest(privateKey: CryptoKey, deviceId: string, method: string, pathWithQuery: string, body: string): Promise<Record<string, string>> {
  const ts = String(Math.floor(Date.now() / 1000));
  const n = nonce();
  const payload = buildSigningPayload(method, pathWithQuery, await sha256Hex(body), ts, n);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(payload));
  return {
    [DEVICE_HEADERS.id]: deviceId,
    [DEVICE_HEADERS.ts]: ts,
    [DEVICE_HEADERS.nonce]: n,
    [DEVICE_HEADERS.sig]: bytesToBase64Url(new Uint8Array(sig)),
  };
}
