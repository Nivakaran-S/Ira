import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const STATE_FILE = fileURLToPath(new URL('./.state.json', import.meta.url));

/** One super admin per spec file: each spec signs in once and consumes its own one-time code. */
export const ADMIN_KEYS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm6b', 'm7', 'm7b'] as const;
export type AdminKey = (typeof ADMIN_KEYS)[number];

function createAdmin(key: string) {
  const email = `e2e-${key}-${Date.now()}@pos.test`;
  const out = execFileSync(process.execPath, ['--env-file=.env', '--import', 'tsx', 'scripts/create-super-admin.ts', '--email', email, '--name', 'E2E Admin'], {
    cwd: fileURLToPath(new URL('../../backend', import.meta.url)),
    encoding: 'utf8',
  });
  const lines = out.split(/\r?\n/);
  const code = lines[lines.findIndex((l) => l.startsWith('One-time setup code')) + 1]?.trim();
  if (!code) throw new Error('create-super-admin did not print a setup code');
  return { email, code };
}

/** Creates fresh super admins through the real bootstrap CLI and hands their one-time codes to the tests. */
export default async function globalSetup() {
  writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(ADMIN_KEYS.map((k) => [k, createAdmin(k)]))));
}
