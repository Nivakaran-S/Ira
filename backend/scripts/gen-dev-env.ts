import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const target = new URL('../.env', import.meta.url);
const example = new URL('../.env.example', import.meta.url);

if (existsSync(target)) {
  console.log('backend/.env already exists; leaving it untouched.');
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (s: string) => Buffer.from(s).toString('base64');
const values: Record<string, string> = {
  JWT_PRIVATE_KEY: b64(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
  JWT_PUBLIC_KEY: b64(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  PII_KEY: randomBytes(32).toString('base64'),
};

const out = readFileSync(example, 'utf8')
  .split('\n')
  .map((line) => {
    const key = line.split('=')[0];
    return key && key in values ? `${key}=${values[key]}` : line;
  })
  .join('\n');

writeFileSync(target, out, { mode: 0o600 });
console.log('Wrote backend/.env with fresh JWT keys and PII key.');
