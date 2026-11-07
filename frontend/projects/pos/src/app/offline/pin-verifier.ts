import { inject, Injectable } from '@angular/core';
import { LocalDb } from './local-db';

const ITERATIONS = 210_000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

interface VerifierRecord {
  userId: string;
  salt: string;
  hash: string;
  failures: number;
  lockedUntil: number;
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, 256);
  return b64(new Uint8Array(bits));
}

function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type OfflinePinResult = 'ok' | 'wrong' | 'locked' | 'unknown';

/**
 * Offline PIN sign-in. The server never sends PIN material: when someone signs in online on this
 * till, the till keeps a slow, salted hash of the PIN they typed, sealed in the local store. Offline,
 * only people who have signed in here before can sign in, with the same lockout rule as the API.
 */
@Injectable({ providedIn: 'root' })
export class PinVerifiers {
  private readonly db = inject(LocalDb);

  async remember(userId: string, pin: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const rec: VerifierRecord = { userId, salt: b64(salt), hash: await derive(pin, salt), failures: 0, lockedUntil: 0 };
    await this.db.put('verifiers', userId, rec);
  }

  async has(userId: string): Promise<boolean> {
    return !!(await this.db.get<VerifierRecord>('verifiers', userId));
  }

  async known(): Promise<string[]> {
    return (await this.db.all<VerifierRecord>('verifiers')).map((r) => r.value.userId);
  }

  async verify(userId: string, pin: string, now = Date.now()): Promise<OfflinePinResult> {
    const rec = await this.db.get<VerifierRecord>('verifiers', userId);
    if (!rec) return 'unknown';
    if (rec.lockedUntil > now) return 'locked';
    if (equal(await derive(pin, unb64(rec.salt) as Uint8Array<ArrayBuffer>), rec.hash)) {
      if (rec.failures) await this.db.put('verifiers', userId, { ...rec, failures: 0, lockedUntil: 0 });
      return 'ok';
    }
    const failures = rec.failures + 1;
    await this.db.put('verifiers', userId, { ...rec, failures: failures >= MAX_FAILURES ? 0 : failures, lockedUntil: failures >= MAX_FAILURES ? now + LOCK_MS : 0 });
    return failures >= MAX_FAILURES ? 'locked' : 'wrong';
  }

  forget(userId: string) {
    return this.db.delete('verifiers', userId);
  }
}
