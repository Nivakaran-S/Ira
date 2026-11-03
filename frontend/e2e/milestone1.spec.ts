import { expect, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { STATE_FILE } from './global-setup';
import { totpNow } from './totp';

const ADMIN = 'http://admin.pos.localhost:4200';
const tenantAdmin = (slug: string) => `http://${slug}.pos.localhost:4200`;
const tenantTill = (slug: string) => `http://${slug}.pos.localhost:4201/pos/`;

const PASSWORD = 'correct horse battery staple';
const run = Date.now().toString(36);
const slug = `e2e-${run}`;
const ownerEmail = `owner-${run}@pos.test`;

/** Password → MFA enrolment (scan step simulated by reading the shown key) → signed in. */
async function setPasswordAndEnrolMfa(page: Page, origin: string, code: string, email: string) {
  await page.goto(`${origin}/setup-password?code=${encodeURIComponent(code)}`);
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('Password set. Sign in to continue.')).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Authenticator QR code' })).toBeVisible();
  const secret = (await page.getByTestId('copy-value').textContent())!.trim();
  await page.getByLabel('Six-digit code').fill(totpNow(secret));
}

test.describe.configure({ mode: 'serial' });

test('Milestone 1: onboard a tenant, enrol a till, and sign a cashier in — all in the browser', async ({ browser }) => {
  const { email: adminEmail, code: adminCode } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { email: string; code: string };

  // Separate browser contexts = separate cookie jars, like separate machines.
  const consoleCtx = await browser.newContext();
  const ownerCtx = await browser.newContext();
  const tillCtx = await browser.newContext();

  // ── 1. Super admin: first sign-in, then create the tenant ─────────────────────────────
  const consolePage = await consoleCtx.newPage();
  await setPasswordAndEnrolMfa(consolePage, ADMIN, adminCode, adminEmail);
  await expect(consolePage.getByRole('heading', { name: 'Tenants' })).toBeVisible();

  await consolePage.getByRole('link', { name: 'New tenant' }).click();
  await consolePage.getByLabel('Business name').fill(`E2E Store ${run}`);
  await consolePage.getByLabel('Slug').fill(slug);
  await consolePage.getByLabel('Business type').selectOption({ label: 'Retail' });
  await consolePage.getByLabel('Owner name').fill('Nimal Owner');
  await consolePage.getByLabel('Owner email').fill(ownerEmail);
  await consolePage.getByRole('button', { name: 'Create tenant' }).click();
  await expect(consolePage.getByTestId('tenant-created')).toBeVisible();
  const ownerCode = (await consolePage.getByTestId('owner-setup-code').getByTestId('copy-value').textContent())!.trim();
  expect(ownerCode.length).toBeGreaterThanOrEqual(16);

  // The new tenant shows in the list.
  await consolePage.getByRole('link', { name: '← Tenants' }).click();
  await expect(consolePage.getByRole('link', { name: `E2E Store ${run}` })).toBeVisible();

  // ── 2. Owner: set password, enrol MFA, build the shop ─────────────────────────────────
  const owner = await ownerCtx.newPage();
  await setPasswordAndEnrolMfa(owner, tenantAdmin(slug), ownerCode, ownerEmail);
  await expect(owner.getByTestId('welcome')).toHaveText('Welcome, Nimal Owner');

  // A tenant session means nothing on the platform host: cookies are per host, and the realm differs.
  const probe = await ownerCtx.newPage();
  await probe.goto(ADMIN);
  await expect(probe.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await probe.close();

  await owner.getByRole('link', { name: 'Stores' }).click();
  await owner.getByLabel('Name').fill('Main street');
  await owner.getByLabel('Code').fill('MAIN');
  await owner.getByRole('button', { name: 'Add store' }).click();
  await expect(owner.getByRole('cell', { name: 'MAIN', exact: true })).toBeVisible();

  await owner.getByRole('link', { name: 'Registers' }).click();
  await owner.getByLabel('Store').selectOption({ label: 'MAIN — Main street' });
  await owner.getByLabel('Name').fill('Front counter');
  await owner.getByLabel('Code').fill('T1');
  await owner.getByRole('button', { name: 'Add register' }).click();
  await expect(owner.getByRole('cell', { name: 'T1', exact: true })).toBeVisible();

  await owner.getByRole('link', { name: 'Users' }).click();
  await owner.getByTestId('new-user').click();
  await owner.getByLabel('Name').fill('Kamal Cashier');
  await owner.getByLabel('PIN (optional)').fill('4321');
  await owner.getByRole('checkbox', { name: 'Cashier' }).check();
  await owner.getByRole('button', { name: 'Create user' }).click();
  await expect(owner.getByTestId('user-created')).toContainText('Kamal Cashier was created');
  await owner.getByTestId('dismiss-code').click();

  await owner.getByRole('link', { name: 'Devices' }).click();
  await owner.getByLabel('Register').selectOption({ label: 'T1 — Front counter' });
  await owner.getByRole('button', { name: 'Create enrollment code' }).click();
  const enrollmentCode = (await owner.getByTestId('enrollment-code').getByTestId('copy-value').textContent())!.trim();
  expect(enrollmentCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

  // ── 3. Till: enrol with the code, cashier signs in with a PIN ─────────────────────────
  const till = await tillCtx.newPage();
  await till.goto(tenantTill(slug));
  await expect(till.getByRole('heading', { name: 'Set up this till' })).toBeVisible();
  await till.getByLabel('Enrollment code').fill(enrollmentCode);
  await till.getByLabel('Till name').fill('Front till');
  await till.getByRole('button', { name: 'Enrol this till' }).click();

  await expect(till.getByRole('heading', { name: "Who's on the till?" })).toBeVisible();
  await till.getByRole('button', { name: /Kamal Cashier/ }).click();
  // A wrong PIN is refused and cleared.
  for (const d of '9999') await till.getByRole('button', { name: d, exact: true }).click();
  await till.getByRole('button', { name: 'Enter' }).click();
  await expect(till.getByRole('alert')).toHaveText('Wrong PIN. Try again.');
  for (const d of '4321') await till.getByRole('button', { name: d, exact: true }).click();
  await till.getByRole('button', { name: 'Enter' }).click();
  await expect(till.getByTestId('till-ready')).toBeVisible();
  await expect(till.getByTestId('cashier')).toHaveText('Kamal Cashier');

  // The session survives a reload (silent, device-signed refresh) and the key stays on the device.
  await till.reload();
  await expect(till.getByTestId('cashier')).toHaveText('Kamal Cashier');

  // The manager, still looking at the code, sees the till land; the audit chain verifies.
  await expect(owner.getByText('Front till enrolled')).toBeVisible();
  await expect(owner.locator('[data-device="Front till"]')).toContainText('Active');
  await owner.getByRole('link', { name: 'Audit log' }).click();
  await owner.getByRole('button', { name: 'Verify chain' }).click();
  await expect(owner.getByTestId('chain-ok')).toBeVisible();

  // ── 4. Revocation: the till is cut off immediately and asks to be enrolled again ──────
  await owner.getByRole('link', { name: 'Devices' }).click();
  owner.once('dialog', (d) => void d.accept());
  await owner.locator('[data-device="Front till"]').getByRole('button', { name: 'Revoke' }).click();
  await expect(owner.locator('[data-device="Front till"]')).toContainText('Revoked');

  await till.reload();
  await expect(till.getByRole('heading', { name: 'Set up this till' })).toBeVisible();
  await expect(till.getByText('This till was revoked by a manager')).toBeVisible();

  // ── 5. Platform control: suspending the tenant locks its back office out ──────────────
  await consolePage.getByRole('link', { name: `E2E Store ${run}` }).click();
  await consolePage.getByRole('button', { name: 'Suspend' }).click();
  await expect(consolePage.getByTestId('tenant-status')).toHaveText('Suspended');
  await owner.getByRole('link', { name: 'Stores' }).click();
  await expect(owner.getByText('This business is suspended')).toBeVisible();

  await Promise.all([consoleCtx.close(), ownerCtx.close(), tillCtx.close()]);
});
