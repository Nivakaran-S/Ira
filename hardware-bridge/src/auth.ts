import { createHash, randomInt, webcrypto } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { buildSigningPayload, DEVICE_HEADERS } from '@pos/shared';

export interface DevicePublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface Pairing {
  deviceId: string;
  publicKeyJwk: DevicePublicJwk;
  pairedAt: string;
}

export const MAX_SKEW_SEC = 120;

/** The paired till, persisted next to the config. Only that device's signatures are accepted. */
export class PairingStore {
  private current: Pairing | null = null;
  constructor(private readonly file: string | null) {}

  async load() {
    if (!this.file) return;
    try {
      this.current = JSON.parse(await readFile(this.file, 'utf8')) as Pairing;
    } catch {
      this.current = null;
    }
  }
  get(): Pairing | null {
    return this.current;
  }
  async set(p: Pairing | null) {
    this.current = p;
    if (this.file) await writeFile(this.file, JSON.stringify(p, null, 2));
  }
}

/**
 * A short code printed on the bridge's console. Pairing needs it, so a web page cannot silently
 * pair itself with a till it does not sit in front of.
 */
export class PairingCode {
  private code = '';
  private expires = 0;
  private failures = 0;

  /** onNew announces each fresh code (the bridge prints it on its console). */
  constructor(private readonly onNew: (code: string) => void = () => undefined) {}

  current(now = Date.now()): string {
    if (!this.code || now > this.expires) {
      this.code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      this.expires = now + 10 * 60_000;
      this.failures = 0;
      this.onNew(this.code);
    }
    return this.code;
  }

  /** Single use. Five wrong guesses burn the code, so it cannot be brute-forced. */
  consume(candidate: string): boolean {
    const ok = !!this.code && Date.now() <= this.expires && candidate === this.code;
    if (ok || ++this.failures >= 5) {
      this.code = '';
      this.failures = 0;
      if (!ok) this.current();
    }
    return ok;
  }
}

class Nonces {
  private readonly seen = new Map<string, number>();
  claim(nonce: string, now: number): boolean {
    for (const [n, exp] of this.seen) if (exp < now) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + 2 * MAX_SKEW_SEC * 1000);
    return true;
  }
}

export class SignatureVerifier {
  private readonly nonces = new Nonces();
  constructor(private readonly pairing: PairingStore) {}

  /** Same scheme as the API: method|path|sha256(body)|ts|nonce, ECDSA P-256 over SHA-256. */
  async verify(method: string, path: string, body: Buffer, headers: Record<string, string | string[] | undefined>): Promise<boolean> {
    const p = this.pairing.get();
    if (!p) return false;
    const h = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    const id = h(DEVICE_HEADERS.id);
    const ts = h(DEVICE_HEADERS.ts);
    const nonce = h(DEVICE_HEADERS.nonce);
    const sig = h(DEVICE_HEADERS.sig);
    if (!id || !ts || !nonce || !sig || id !== p.deviceId || !/^\d{1,12}$/.test(ts) || !/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return false;
    const now = Date.now();
    if (Math.abs(now / 1000 - Number(ts)) > MAX_SKEW_SEC) return false;
    const payload = buildSigningPayload(method, path, createHash('sha256').update(body).digest('hex'), ts, nonce);
    let ok = false;
    try {
      const key = await webcrypto.subtle.importKey('jwk', { ...p.publicKeyJwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig, 'base64url'), new TextEncoder().encode(payload));
    } catch {
      ok = false;
    }
    return ok && this.nonces.claim(nonce, now);
  }
}
