import { createHash, randomBytes, randomInt } from 'node:crypto';

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Human-typeable code without 0/O/1/I ambiguity. */
export function randomCode(length = 8): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}
