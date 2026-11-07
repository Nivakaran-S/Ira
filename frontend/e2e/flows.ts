import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { type AdminKey, STATE_FILE } from './global-setup';
import { totpNow } from './totp';

export const ADMIN = 'http://admin.pos.localhost:4200';
export const tenantAdmin = (slug: string) => `http://${slug}.pos.localhost:4200`;
export const tenantTill = (slug: string) => `http://${slug}.pos.localhost:4201/pos/`;
export const PASSWORD = 'correct horse battery staple';

export function adminFor(key: AdminKey): { email: string; code: string } {
  return (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Record<string, { email: string; code: string }>)[key]!;
}

/** Password, then MFA enrolment (the shown key stands in for scanning the QR code). */
export async function setPasswordAndEnrolMfa(page: Page, origin: string, code: string, email: string) {
  await page.goto(`${origin}/setup-password?code=${encodeURIComponent(code)}`);
  await page.getByLabel('New password').fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByText('Password set. Sign in to continue.')).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  const secret = (await page.getByTestId('copy-value').textContent())!.trim();
  await page.getByLabel('Six-digit code').fill(totpNow(secret));
}

export interface Shop {
  slug: string;
  contexts: BrowserContext[];
  console: Page;
  owner: Page;
  till: Page;
  close(): Promise<void>;
}

/**
 * Super admin creates a tenant of `businessType`; the owner signs in and adds store MAIN, register T1,
 * a cashier (PIN 4321) and a manager (PIN 2468); the till is enrolled. Returns three pages.
 */
export async function openShop(browser: Browser, key: AdminKey, businessType: string, tillName = 'Front till'): Promise<Shop> {
  const run = `${key}-${Date.now().toString(36)}`;
  const slug = `e2e-${run}`;
  const ownerEmail = `owner-${run}@pos.test`;
  const admin = adminFor(key);
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [consolePage, owner, till] = await Promise.all(contexts.map((c) => c.newPage()));

  await setPasswordAndEnrolMfa(consolePage, ADMIN, admin.code, admin.email);
  await expect(consolePage.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  await consolePage.getByRole('link', { name: 'New tenant' }).click();
  await consolePage.getByLabel('Business name').fill(`Shop ${run}`);
  await consolePage.getByLabel('Slug').fill(slug);
  await consolePage.getByLabel('Business type').selectOption({ label: businessType });
  await consolePage.getByLabel('Owner name').fill('Nimal Owner');
  await consolePage.getByLabel('Owner email').fill(ownerEmail);
  await consolePage.getByRole('button', { name: 'Create tenant' }).click();
  const ownerCode = (await consolePage.getByTestId('owner-setup-code').getByTestId('copy-value').textContent())!.trim();

  await setPasswordAndEnrolMfa(owner, tenantAdmin(slug), ownerCode, ownerEmail);
  await expect(owner.getByTestId('welcome')).toBeVisible();

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
  for (const [name, pin, role] of [['Kamal Cashier', '4321', 'Cashier'], ['Sara Manager', '2468', 'Manager']] as const) {
    await owner.getByTestId('new-user').click();
    await owner.getByLabel('Name').fill(name);
    await owner.getByLabel('PIN (optional)').fill(pin);
    await owner.getByRole('checkbox', { name: role, exact: true }).check();
    await owner.getByRole('button', { name: 'Create user' }).click();
    await expect(owner.getByTestId('user-created')).toContainText(`${name} was created`);
    await owner.getByTestId('dismiss-code').click();
  }

  await owner.getByRole('link', { name: 'Devices' }).click();
  await owner.getByLabel('Register').selectOption({ label: 'T1 — Front counter' });
  await owner.getByRole('button', { name: 'Create enrollment code' }).click();
  const enrollmentCode = (await owner.getByTestId('enrollment-code').getByTestId('copy-value').textContent())!.trim();

  await till.goto(tenantTill(slug));
  await till.getByLabel('Enrollment code').fill(enrollmentCode);
  await till.getByLabel('Till name').fill(tillName);
  await till.getByRole('button', { name: 'Enrol this till' }).click();
  await expect(till.getByRole('heading', { name: "Who's on the till?" })).toBeVisible();

  return { slug, contexts, console: consolePage, owner, till, close: async () => void (await Promise.all(contexts.map((c) => c.close()))) };
}

export async function typePin(page: Page, pin: string) {
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Enter' }).click();
}

export async function pinLogin(till: Page, name: string, pin: string) {
  await till.getByRole('button', { name: new RegExp(name) }).click();
  await typePin(till, pin);
}

/** Answers the manager-approval dialog as Sara Manager. */
export async function approveAsManager(till: Page) {
  const dlg = till.getByTestId('approval-dialog');
  await expect(dlg).toBeVisible();
  const pick = dlg.locator('[data-approver="Sara Manager"]');
  if (await pick.isVisible()) await pick.click();
  for (const d of '2468') await dlg.getByRole('button', { name: d, exact: true }).click();
  await dlg.getByRole('button', { name: 'Enter' }).click();
  await expect(dlg).toBeHidden();
}

/** VAT 18% then SSCL 2.5% as group "Standard", and products in a category. */
export async function setUpCatalog(owner: Page, products: { name: string; price: string; sku?: string }[]) {
  await owner.getByRole('link', { name: 'Taxes' }).click();
  for (const [name, pct] of [['VAT', '18'], ['SSCL', '2.5']]) {
    await owner.locator('#t-name').fill(name);
    await owner.locator('#t-pct').fill(pct);
    await owner.getByRole('button', { name: 'Add rate' }).click();
    await expect(owner.getByRole('cell', { name, exact: true })).toBeVisible();
  }
  await owner.getByRole('button', { name: 'New group' }).click();
  await owner.locator('#g-name').fill('Standard');
  await owner.getByLabel('Add rate').selectOption({ label: 'VAT 18%' });
  await owner.getByLabel('Add rate').selectOption({ label: 'SSCL 2.50%' });
  await owner.getByRole('button', { name: 'Save group' }).click();
  await expect(owner.getByRole('cell', { name: 'Standard' })).toBeVisible();

  await owner.getByRole('link', { name: 'Catalog' }).click();
  await owner.getByLabel('New category').fill('Everyday');
  await owner.getByRole('button', { name: 'Add', exact: true }).click();
  for (const p of products) {
    await owner.getByTestId('new-product').click();
    const form = owner.getByTestId('product-form');
    await form.getByLabel('Name').fill(p.name);
    await form.getByLabel('Price', { exact: true }).fill(p.price);
    if (p.sku) await form.getByLabel('SKU (optional)').fill(p.sku);
    await form.getByLabel('Category').selectOption({ label: 'Everyday' });
    await form.getByLabel('Tax').selectOption({ label: 'Standard' });
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(owner.locator(`[data-product="${p.name}"]`)).toBeVisible();
  }
}
