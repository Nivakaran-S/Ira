import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end against the real API on the dev database (`pos`). Needs `npm run infra:up`, a migrated and
 * seeded database, and backend/.env (see README). Each run uses fresh slugs and emails.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node --env-file=.env dist/main.js',
      cwd: '../backend',
      url: 'http://127.0.0.1:3000/api/health',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npx ng serve admin',
      url: 'http://127.0.0.1:4200/',
      reuseExistingServer: true,
      timeout: 240_000,
    },
    {
      command: 'npx ng serve pos',
      url: 'http://127.0.0.1:4201/pos/',
      reuseExistingServer: true,
      timeout: 240_000,
    },
  ],
});
