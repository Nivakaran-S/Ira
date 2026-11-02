import 'reflect-metadata';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

config({ path: fileURLToPath(new URL('../.env.test', import.meta.url)), override: true });

// Fresh, throwaway keys per test process: nothing secret is committed.
if (!process.env.JWT_PRIVATE_KEY) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  process.env.JWT_PRIVATE_KEY = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64');
  process.env.JWT_PUBLIC_KEY = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }).toString()).toString('base64');
}
process.env.PII_KEY ??= randomBytes(32).toString('base64');
