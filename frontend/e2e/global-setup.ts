import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const STATE_FILE = fileURLToPath(new URL('./.state.json', import.meta.url));

/** Creates a fresh super admin through the real bootstrap CLI and hands its one-time code to the tests. */
export default async function globalSetup() {
  const email = `e2e-${Date.now()}@pos.test`;
  const out = execFileSync(process.execPath, ['--env-file=.env', '--import', 'tsx', 'scripts/create-super-admin.ts', '--email', email, '--name', 'E2E Admin'], {
    cwd: fileURLToPath(new URL('../../backend', import.meta.url)),
    encoding: 'utf8',
  });
  const lines = out.split(/\r?\n/);
  const code = lines[lines.findIndex((l) => l.startsWith('One-time setup code')) + 1]?.trim();
  if (!code) throw new Error('create-super-admin did not print a setup code');
  writeFileSync(STATE_FILE, JSON.stringify({ email, code }));
}
