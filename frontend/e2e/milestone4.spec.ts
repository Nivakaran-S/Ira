import { expect, test } from '@playwright/test';
import { openShop, pinLogin, setUpCatalog } from './flows';

test('Milestone 4: barcodes, promotions, variants, customers and loyalty', async ({ browser }) => {
  const shop = await openShop(browser, 'm4', 'Retail');
  const { owner, till } = shop;
  await setUpCatalog(owner, [
    { name: 'Ceylon tea', price: '500' },
    { name: 'T-shirt', price: '1500' },
  ]);

  // Back office: a barcode on the tea, variants of the T-shirt, a promotion.
  await owner.locator('[data-product="Ceylon tea"]').getByRole('button', { name: 'Edit' }).click();
  await owner.getByTestId('product-form').getByLabel('Barcodes').fill('4791234567890');
  await owner.getByTestId('product-form').getByRole('button', { name: 'Save' }).click();
  await expect(owner.locator('[data-product="Ceylon tea"]')).toContainText('4791234567890');

  await owner.locator('[data-variants="T-shirt"]').click();
  await owner.getByTestId('variants-form').getByLabel('New variants').fill('S, M');
  await owner.getByTestId('variants-form').getByRole('button', { name: 'Add variants' }).click();
  await expect(owner.getByTestId('variants-form')).toContainText('M');
  await owner.keyboard.press('Escape');

  await owner.getByRole('link', { name: 'Promotions' }).click();
  await owner.getByTestId('new-promotion').click();
  const form = owner.getByTestId('promotion-form');
  await form.getByLabel('Name').fill('Tea 10%');
  await form.getByLabel('Percent off').fill('10');
  await form.locator('[data-prod="Ceylon tea"]').check();
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(owner.locator('[data-promotion="Tea 10%"]')).toBeVisible();

  // Till: scan, pick a variant, attach a new customer, pay.
  await pinLogin(till, 'Kamal Cashier', '4321');
  await till.getByTestId('float').fill('0');
  await till.getByTestId('open-shift-btn').click();
  await expect(till.getByTestId('shift-open')).toBeVisible();
  await expect(till.locator('[data-product="T-shirt"]')).toContainText('2 options');

  await till.locator('body').click({ position: { x: 5, y: 600 } });
  await till.keyboard.type('4791234567890');
  await till.keyboard.press('Enter');
  await expect(till.getByTestId('line-promo')).toHaveText('Tea 10%');

  await till.locator('[data-product="T-shirt"]').click();
  await till.locator('[data-variant="M"]').click();
  await expect(till.getByTestId('cart-total')).toHaveText('1,950.00');

  await till.getByTestId('add-customer-btn').click();
  await till.getByTestId('customer-q').fill('0771112223');
  await till.getByRole('button', { name: 'Find' }).click();
  await till.getByTestId('new-customer-name').fill('Amal Silva');
  await till.getByTestId('add-customer').click();
  await expect(till.getByTestId('cart-customer')).toContainText('Amal Silva');

  await till.getByTestId('pay').click();
  await till.locator('[data-method="CARD"]').click();
  await till.getByTestId('complete').click();
  await expect(till.getByTestId('sale-complete')).toContainText('Points earned: 19');
  await till.getByTestId('new-sale').click();

  // Back office: the customer with the points; phone stored, searchable.
  await owner.getByRole('link', { name: 'Customers' }).click();
  await owner.getByLabel('Search customers').fill('+94 77 111 2223');
  await owner.getByRole('button', { name: 'Search' }).click();
  await owner.locator('[data-customer="Amal Silva"]').getByRole('link', { name: 'Open' }).click();
  await expect(owner.getByTestId('points')).toHaveText('19');

  await shop.close();
});
