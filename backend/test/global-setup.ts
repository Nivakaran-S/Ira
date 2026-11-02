import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

export default async function globalSetup() {
  config({ path: fileURLToPath(new URL('../.env.test', import.meta.url)), override: true });
  execSync('npx prisma migrate deploy', {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
    env: process.env,
  });
}
