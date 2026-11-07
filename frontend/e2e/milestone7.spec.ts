import { expect, test } from '@playwright/test';
import { openShop, pinLogin, setUpCatalog } from './flows';

test('Milestone 7: second store, purchasing, transfer, store price, margin insights and billing', async ({ browser }) => {
  const shop = await openShop(browser, 'm7', 'Retail chain');
  const { owner, till, console: consolePage } = shop;
  const tenantName = `Shop ${shop.slug.replace(/^e2e-/, '')}`;
  await setUpCatalog(owner, [{ name: 'Ceylon tea', price: '500' }]);

  await owner.getByRole('link', { name: 'Stores' }).click();
  await owner.getByLabel('Name').fill('Kandy');
  await owner.getByLabel('Code').fill('KDY');
  await owner.getByRole('button', { name: 'Add store' }).click();
  await expect(owner.getByRole('cell', { name: 'KDY', exact: true })).toBeVisible();

  // Buy 20 at 300 each into the main store.
  await owner.getByRole('link', { name: 'Purchasing' }).click();
  await owner.getByLabel('Supplier name').fill('Lanka Wholesale');
  await owner.getByRole('button', { name: 'Add supplier' }).click();
  await owner.getByTestId('new-po').click();
  const po = owner.getByTestId('po-form');
  await po.getByLabel('Deliver to').selectOption({ label: 'MAIN · Main street' });
  await po.getByLabel('Product 1').selectOption({ label: 'Ceylon tea' });
  await po.getByLabel('Quantity 1').fill('20');
  await po.getByLabel('Unit cost 1').fill('300');
  await po.getByRole('button', { name: 'Create order' }).click();
  await owner.locator('[data-po="PO-000001"]').getByRole('button', { name: 'Open' }).click();
  await owner.getByTestId('po-send').click();
  await owner.getByLabel('Receive Ceylon tea').fill('20');
  await owner.getByTestId('po-receive').click();
  await expect(owner.getByTestId('po-detail')).toContainText('20 of 20 received');
  await owner.keyboard.press('Escape');
  await expect(owner.locator('[data-po="PO-000001"]')).toContainText('RECEIVED');

  // Move 5 to Kandy and give Kandy its own price.
  await owner.getByRole('link', { name: 'Transfers' }).click();
  await owner.getByTestId('new-transfer').click();
  const tr = owner.getByTestId('transfer-form');
  await tr.getByLabel('From').selectOption({ label: 'MAIN · Main street' });
  await tr.getByLabel('To').selectOption({ label: 'KDY · Kandy' });
  await tr.getByLabel('Product').selectOption({ label: 'Ceylon tea' });
  await tr.getByLabel('Quantity').fill('5');
  await tr.getByRole('button', { name: 'Send' }).click();
  await owner.locator('[data-transfer="TR-000001"]').getByRole('button', { name: 'Receive' }).click();
  await owner.getByTestId('confirm-receive').click();
  await expect(owner.locator('[data-transfer="TR-000001"]')).toContainText('RECEIVED');

  await owner.getByRole('link', { name: 'Store prices' }).click();
  await owner.getByLabel('Store', { exact: true }).selectOption({ label: 'KDY · Kandy' });
  await owner.getByLabel('Store price Ceylon tea').fill('550');
  await owner.getByTestId('save-prices').click();
  await expect(owner.getByText('Store prices saved')).toBeVisible();

  // Sell two at the main store's till (catalog price).
  await pinLogin(till, 'Kamal Cashier', '4321');
  await till.getByTestId('float').fill('0');
  await till.getByTestId('open-shift-btn').click();
  await till.locator('[data-product="Ceylon tea"]').click();
  await till.locator('[data-product="Ceylon tea"]').click();
  await expect(till.getByTestId('cart-total')).toHaveText('1,000.00');
  await till.getByTestId('pay').click();
  await till.locator('[data-method="CARD"]').click();
  await till.getByTestId('complete').click();
  await expect(till.getByTestId('sale-complete')).toBeVisible();

  // Margin: 1,000 revenue against 600 cost.
  await owner.getByRole('link', { name: 'Insights' }).click();
  await expect(owner.locator('[data-row="Ceylon tea"]')).toContainText('400.00');
  await owner.getByLabel('Store', { exact: true }).selectOption({ label: 'MAIN · Main street' });
  await expect(owner.getByTestId('stock-value')).toHaveText('3,900.00'); // 20 in, 5 moved, 2 sold: 13 × 300

  // Platform: a paid plan, an invoice, payment recorded; the owner sees it.
  await consolePage.getByRole('link', { name: 'Plans' }).click();
  await consolePage.getByTestId('new-plan').click();
  const pf = consolePage.getByTestId('plan-form');
  await pf.getByLabel('Key').fill(`pro-${Date.now().toString(36)}`);
  await pf.getByLabel('Name').fill('Pro chain');
  await pf.getByLabel('Monthly price').fill('15000');
  await pf.getByLabel('Stores').fill('10');
  await pf.getByLabel('Devices').fill('50');
  await pf.getByLabel('Users').fill('100');
  await pf.getByLabel('Products').fill('10000');
  await pf.getByRole('button', { name: 'Save plan' }).click();
  await expect(consolePage.getByText('Plan saved')).toBeVisible();

  await consolePage.getByRole('link', { name: 'Tenants' }).click();
  await consolePage.getByRole('link', { name: tenantName }).click();
  await consolePage.getByTestId('tenant-billing').getByLabel('Plan').selectOption({ label: 'Pro chain' });
  await expect(consolePage.getByText('Plan changed')).toBeVisible();
  await consolePage.getByRole('link', { name: 'Invoices' }).click();
  await consolePage.getByTestId('run-billing').click();
  const row = consolePage.locator(`[data-invoice$="-${shop.slug}"]`);
  await row.getByLabel('Payment reference').fill('BOC-TT-1234');
  await row.getByRole('button', { name: 'Mark paid' }).click();
  await expect(consolePage.getByText(/marked paid/)).toBeVisible();

  await owner.getByRole('link', { name: 'Plan and billing' }).click();
  await expect(owner.getByTestId('plan-name')).toHaveText('Pro chain');
  await expect(owner.getByText('PAID')).toBeVisible();

  await shop.close();
});
