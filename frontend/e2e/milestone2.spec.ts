import { expect, test } from '@playwright/test';
import { approveAsManager, openShop, pinLogin, setUpCatalog } from './flows';

test('Milestone 2: catalog and taxes, a cash sale with change, refund and void with manager approval, Z report, reports', async ({ browser }) => {
  const shop = await openShop(browser, 'm2', 'Retail');
  const { owner, till } = shop;

  await setUpCatalog(owner, [
    { name: 'Ceylon tea', price: '500' },
    { name: 'Butter cake', price: '1250' },
  ]);

  // ── Till: open a shift and sell ─────────────────────────────────────────────────────
  await pinLogin(till, 'Kamal Cashier', '4321');
  await expect(till.getByTestId('open-shift')).toBeVisible();
  await till.getByTestId('float').fill('5000');
  await till.getByTestId('open-shift-btn').click();
  await expect(till.getByTestId('shift-open')).toBeVisible();

  await till.locator('[data-product="Ceylon tea"]').click();
  await till.locator('[data-product="Ceylon tea"]').click();
  await till.locator('[data-product="Butter cake"]').click();
  await expect(till.getByTestId('cart-total')).toHaveText('2,250.00');

  await till.getByTestId('pay').click();
  await till.getByTestId('tendered').fill('3000');
  await till.getByTestId('complete').click();
  await expect(till.getByTestId('sale-complete')).toBeVisible();
  await expect(till.getByTestId('change')).toHaveText('750.00');
  const receiptNo = (await till.getByTestId('sale-complete').locator('.muted').first().textContent())!.replace('Receipt ', '').trim();
  expect(receiptNo).toMatch(/^T1-\d{6}$/);
  await till.getByTestId('new-sale').click();

  // A discount from a cashier needs Sara's PIN.
  await till.locator('[data-product="Butter cake"]').click();
  await till.getByRole('button', { name: 'Discount' }).click();
  await till.getByRole('button', { name: '10%' }).click();
  await expect(till.getByTestId('cart-total')).toHaveText('1,125.00');
  await till.getByTestId('pay').click();
  await till.locator('[data-method="CARD"]').click();
  await till.getByTestId('reference').fill('APPR-77');
  await till.getByTestId('complete').click();
  await approveAsManager(till);
  await expect(till.getByTestId('sale-complete')).toBeVisible();
  await till.getByTestId('new-sale').click();

  // ── Refund one tea from the first sale (manager approval) ──────────────────────────
  await till.getByTestId('tab-refund').click();
  await till.getByTestId('receipt-no').fill(receiptNo);
  await till.getByRole('button', { name: 'Find' }).click();
  await till.locator('[data-refund-line="Ceylon tea"]').fill('1');
  await till.getByTestId('refund-reason').fill('Spilled');
  await till.getByTestId('do-refund').click();
  await approveAsManager(till);
  await expect(till.getByText(/Refunded 500\.00/)).toBeVisible();

  // ── Void the card sale ──────────────────────────────────────────────────────────────
  await till.getByTestId('tab-sales').click();
  const second = till.locator('tr[data-receipt]').first();
  await second.getByRole('button', { name: 'Open' }).click();
  await till.getByTestId('void').click();
  await till.getByTestId('void-reason').fill('Customer left');
  await till.getByTestId('confirm-void').click();
  await approveAsManager(till);
  await expect(till.locator('tr[data-receipt]').first()).toContainText('Voided');

  // ── Close the shift: 5000 float + 2250 cash − 500 refund = 6750 expected ────────────
  await till.getByTestId('tab-shift').click();
  await expect(till.getByTestId('expected-cash')).toHaveText('6,750.00');
  await till.getByTestId('counted').fill('6700');
  await till.getByTestId('close-shift').click();
  await approveAsManager(till); // cashiers do not hold shift.close
  await expect(till.getByTestId('z-report')).toBeVisible();
  await expect(till.getByTestId('variance')).toHaveText('-50.00');

  // ── Back office sees it ─────────────────────────────────────────────────────────────
  await owner.getByRole('link', { name: 'Reports' }).click();
  await owner.getByRole('button', { name: 'Today' }).click();
  await expect(owner.getByTestId('net-sales')).toHaveText('1,750.00');
  await owner.getByRole('link', { name: 'Sales', exact: true }).click();
  await expect(owner.getByRole('cell', { name: receiptNo })).toBeVisible();
  await owner.getByRole('link', { name: 'Shifts' }).click();
  await expect(owner.getByRole('cell', { name: '-50.00' })).toBeVisible();

  await shop.close();
});
