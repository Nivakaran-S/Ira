import { createHmac, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './base32.js';

export const TOTP_STEP_SECONDS = 30;

export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export const totpCounter = (timeMs: number): number => Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);

export const totp = (key: Buffer, timeMs = Date.now()): string => hotp(key, totpCounter(timeMs));

/**
 * Returns the counter that matched (store it to block replay), or null.
 * Accepts one step of clock drift either way; never accepts a counter <= lastUsedCounter.
 */
export function verifyTotp(key: Buffer, code: string, timeMs = Date.now(), lastUsedCounter: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpCounter(timeMs);
  for (const counter of [now - 1, now, now + 1]) {
    if (lastUsedCounter !== null && counter <= lastUsedCounter) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, counter)), Buffer.from(code))) return counter;
  }
  return null;
}

export function otpauthUrl(issuer: string, account: string, secret: Buffer): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
