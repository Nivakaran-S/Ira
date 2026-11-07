import { expect, test } from '@playwright/test';
import { approveAsManager, openShop, pinLogin, setUpCatalog } from './flows';

test('Milestone 3: the till keeps selling offline, signs staff in offline, and syncs when the network returns', async ({ browser }) => {
  const shop = await openShop(browser, 'm3', 'Retail');
  const { owner, till } = shop;
  await setUpCatalog(owner, [{ name: 'Ceylon tea', price: '500' }]);

  // Online first: each person who will need to sign in or approve offline signs in here once.
  await pinLogin(till, 'Sara Manager', '2468');
  await expect(till.getByTestId('open-shift')).toBeVisible();
  await till.getByTestId('float').fill('1000');
  await till.getByTestId('open-shift-btn').click();
  await expect(till.getByTestId('shift-open')).toBeVisible();
  await till.getByRole('button', { name: 'Lock' }).click();
  await pinLogin(till, 'Kamal Cashier', '4321');
  await expect(till.getByTestId('online')).toBeVisible();
  await expect(till.locator('[data-product="Ceylon tea"]')).toBeVisible();

  // ── The network goes away ───────────────────────────────────────────────────────────
  await till.context().setOffline(true);

  await till.locator('[data-product="Ceylon tea"]').click();
  await till.locator('[data-product="Ceylon tea"]').click();
  await till.getByTestId('pay').click();
  await till.getByTestId('tendered').fill('2000');
  await till.getByTestId('complete').click();
  await expect(till.getByTestId('sold-offline')).toBeVisible();
  await expect(till.getByTestId('change')).toHaveText('1,000.00');
  await expect(till.getByTestId('receipt-no-done')).toHaveText('Receipt T1-O000001');
  await till.getByTestId('new-sale').click();
  await expect(till.getByTestId('offline')).toBeVisible();
  await expect(till.getByTestId('outbox')).toHaveText('1 to sync');

  // A discount offline: Sara approves with her PIN, checked on the till.
  await till.locator('[data-product="Ceylon tea"]').click();
  await till.getByRole('button', { name: 'Discount' }).click();
  await till.getByRole('button', { name: '10%' }).click();
  await till.getByTestId('pay').click();
  await till.getByTestId('complete').click();
  await approveAsManager(till);
  await expect(till.getByTestId('sold-offline')).toBeVisible();
  await till.getByTestId('new-sale').click();
  await expect(till.getByTestId('outbox')).toHaveText('2 to sync');

  // Refunds and closing the shift wait for the connection.
  await till.getByTestId('tab-refund').click();
  await expect(till.getByTestId('refund-offline')).toBeVisible();

  // Lock and sign back in with no network: the PIN is checked against the till's own verifier.
  await till.getByRole('button', { name: 'Lock' }).click();
  await expect(till.getByTestId('pin-offline')).toBeVisible();
  await till.getByRole('button', { name: /Kamal Cashier/ }).click();
  for (const d of '0000') await till.getByRole('button', { name: d, exact: true }).click();
  await till.getByRole('button', { name: 'Enter' }).click();
  await expect(till.getByRole('alert')).toHaveText('Wrong PIN. Try again.');
  for (const d of '4321') await till.getByRole('button', { name: d, exact: true }).click();
  await till.getByRole('button', { name: 'Enter' }).click();
  await expect(till.getByTestId('cashier')).toHaveText('Kamal Cashier');
  await till.locator('[data-product="Ceylon tea"]').click();
  await till.getByTestId('pay').click();
  await till.getByTestId('complete').click();
  await expect(till.getByTestId('receipt-no-done')).toHaveText('Receipt T1-O000003');
  await till.getByTestId('new-sale').click();

  // ── The network comes back: the outbox drains ───────────────────────────────────────
  await till.context().setOffline(false);
  await expect(till.getByTestId('online')).toBeVisible({ timeout: 40_000 });
  await expect(till.getByTestId('outbox')).toBeHidden({ timeout: 40_000 });

  // The back office sees the offline sales as facts; nothing needed review.
  await owner.getByRole('link', { name: 'Sales', exact: true }).click();
  await owner.getByRole('button', { name: 'Search' }).click();
  for (const r of ['T1-O000001', 'T1-O000002', 'T1-O000003']) await expect(owner.getByRole('cell', { name: r })).toBeVisible();
  await owner.getByRole('link', { name: 'Offline review' }).click();
  await expect(owner.getByText('Nothing here')).toBeVisible();
  await owner.getByRole('link', { name: 'Reports' }).click();
  await owner.getByRole('button', { name: 'Today' }).click();
  await expect(owner.getByTestId('net-sales')).toHaveText('1,950.00');

  await shop.close();
});
