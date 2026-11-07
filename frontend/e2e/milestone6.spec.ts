import { expect, type Page, test } from '@playwright/test';
import { openShop, pinLogin, setUpCatalog } from './flows';

async function editProduct(owner: Page, name: string, tick: string, extra?: (form: ReturnType<Page['getByTestId']>) => Promise<void>) {
  await owner.getByRole('link', { name: 'Catalog' }).click();
  await owner.locator(`[data-product="${name}"]`).getByRole('button', { name: 'Edit' }).click();
  const form = owner.getByTestId('product-form');
  await form.getByTestId(tick).check();
  if (extra) await extra(form);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(owner.getByText(`${name} saved`)).toBeVisible();
}

const ean13 = (twelve: string) => {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return twelve + ((10 - (sum % 10)) % 10);
};

test('Milestone 6 (pharmacy): lots sold first-expiring-first and a dispensed prescription', async ({ browser }) => {
  const shop = await openShop(browser, 'm6', 'Pharmacy');
  const { owner, till } = shop;
  await setUpCatalog(owner, [
    { name: 'Paracetamol', price: '100' },
    { name: 'Amoxicillin', price: '500' },
  ]);
  await editProduct(owner, 'Paracetamol', 'tracks-batches');
  await editProduct(owner, 'Amoxicillin', 'rx-required');

  await owner.getByRole('link', { name: 'Lots and expiry' }).click();
  await owner.getByLabel('Product').selectOption({ label: 'Paracetamol' });
  await owner.getByLabel('Lot number').fill('L1');
  await owner.getByLabel('Expires').fill(new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10));
  await owner.getByLabel('Quantity').fill('10');
  await owner.getByRole('button', { name: 'Receive' }).click();
  await expect(owner.locator('[data-lot="L1"]')).toContainText('10');

  await owner.getByRole('link', { name: 'Roles' }).click();
  await owner.getByRole('button', { name: 'New role' }).click();
  await owner.locator('#role-name').fill('Pharmacist');
  await owner.getByRole('checkbox', { name: 'sale.create', exact: true }).check();
  await owner.getByRole('checkbox', { name: 'prescription.dispense' }).check();
  await owner.getByRole('button', { name: 'Create role' }).click();
  await owner.getByRole('link', { name: 'Users' }).click();
  await owner.getByTestId('new-user').click();
  await owner.getByLabel('Name').fill('Ruwan Pharmacist');
  await owner.getByLabel('PIN (optional)').fill('3333');
  await owner.getByRole('checkbox', { name: 'Pharmacist', exact: true }).check();
  await owner.getByRole('button', { name: 'Create user' }).click();
  await owner.getByTestId('dismiss-code').click();

  await till.reload(); // the PIN pad was loaded before the pharmacist existed
  await pinLogin(till, 'Ruwan Pharmacist', '3333');
  await till.getByTestId('float').fill('0');
  await till.getByTestId('open-shift-btn').click();
  await till.locator('[data-product="Paracetamol"]').click();
  await till.locator('[data-product="Paracetamol"]').click();

  // Prescription medicine: customer first, then the prescription they brought.
  await till.locator('[data-product="Amoxicillin"]').click();
  await till.getByTestId('customer-q').fill('0711234567');
  await till.getByRole('button', { name: 'Find' }).click();
  await till.getByTestId('new-customer-name').fill('Saman');
  await till.getByTestId('add-customer').click();
  await expect(till.getByTestId('rx-picker')).toBeVisible();
  await till.getByTestId('rx-prescriber').fill('Dr. Perera');
  await till.getByTestId('rx-qty').fill('1');
  await till.getByTestId('rx-save').click();
  await expect(till.getByTestId('cart-total')).toHaveText('700.00');

  await till.getByTestId('pay').click();
  await till.locator('[data-method="CARD"]').click();
  await till.getByTestId('complete').click();
  await expect(till.getByTestId('sale-complete')).toBeVisible();
  const receiptNo = (await till.getByTestId('receipt-no-done').textContent())!.replace('Receipt ', '').trim();

  await owner.getByRole('link', { name: 'Lots and expiry' }).click();
  await expect(owner.locator('[data-lot="L1"]')).toContainText('8');
  await owner.locator('[data-lot="L1"]').getByRole('button', { name: 'Who bought it' }).click();
  await expect(owner.getByText(receiptNo)).toBeVisible();

  await shop.close();
});

test('Milestone 6 (grocery): weighing at the till and an in-store scale label', async ({ browser }) => {
  const shop = await openShop(browser, 'm6b', 'Grocery');
  const { owner, till } = shop;
  await setUpCatalog(owner, [{ name: 'Red rice', price: '400' }]);
  await editProduct(owner, 'Red rice', 'sold-by-weight', (form) => form.getByLabel('PLU').fill('01234'));

  await owner.getByRole('link', { name: 'Settings' }).click();
  await owner.getByRole('checkbox', { name: /scale labels/ }).check();
  await owner.getByRole('button', { name: 'Save settings' }).click();
  await expect(owner.getByText('Settings saved')).toBeVisible();

  await pinLogin(till, 'Kamal Cashier', '4321');
  await till.getByTestId('float').fill('0');
  await till.getByTestId('open-shift-btn').click();
  await expect(till.locator('[data-product="Red rice"]')).toContainText('/kg');
  await till.locator('[data-product="Red rice"]').click();
  await till.getByTestId('weight-kg').fill('1.25');
  await till.getByTestId('weigh-add').click();
  await expect(till.getByTestId('cart-total')).toHaveText('500.00');

  // A label printed by the store's scale: PLU 01234, 0.750 kg.
  await till.locator('body').click({ position: { x: 5, y: 600 } });
  await till.keyboard.type(ean13('201234000750'));
  await till.keyboard.press('Enter');
  await expect(till.getByTestId('cart-total')).toHaveText('800.00');

  await shop.close();
});
