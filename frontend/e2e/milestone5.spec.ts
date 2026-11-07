import { expect, test } from '@playwright/test';
import { openShop, pinLogin, setUpCatalog } from './flows';

test('Milestone 5: modifiers, a table order to the kitchen display, split bill with a tip', async ({ browser }) => {
  const shop = await openShop(browser, 'm5', 'Café / Restaurant');
  const { owner, till } = shop;
  await setUpCatalog(owner, [
    { name: 'Latte', price: '500' },
    { name: 'Tea', price: '300' },
  ]);

  // Back office: a required Size group on the latte, a table, a kitchen role and a cook.
  await owner.getByRole('link', { name: 'Modifiers' }).click();
  await owner.getByTestId('new-group').click();
  const g = owner.getByTestId('group-form');
  await g.getByLabel('Name').fill('Size');
  await g.getByLabel('Must choose at least').fill('1');
  await g.getByLabel('Option 1').fill('Small');
  await g.getByRole('button', { name: '+ Option' }).click();
  await g.getByLabel('Option 2').fill('Large');
  await g.getByLabel('Price 2').fill('150');
  await g.getByRole('button', { name: 'Save' }).click();
  await expect(owner.locator('[data-group="Size"]')).toContainText('Large +150.00');

  await owner.getByRole('link', { name: 'Catalog' }).click();
  await owner.locator('[data-product="Latte"]').getByRole('button', { name: 'Edit' }).click();
  await owner.getByTestId('product-form').locator('[data-mod-group="Size"]').check();
  await owner.getByTestId('product-form').getByRole('button', { name: 'Save' }).click();
  await expect(owner.getByText('Latte saved')).toBeVisible();

  await owner.getByRole('link', { name: 'Tables' }).click();
  await owner.getByLabel('Table').fill('T1');
  await owner.getByRole('button', { name: 'Add table' }).click();
  await expect(owner.getByRole('cell', { name: 'T1', exact: true })).toBeVisible();

  await owner.getByRole('link', { name: 'Roles' }).click();
  await owner.getByRole('button', { name: 'New role' }).click();
  await owner.locator('#role-name').fill('Kitchen');
  await owner.getByRole('checkbox', { name: 'kitchen.view' }).check();
  await owner.getByRole('button', { name: 'Create role' }).click();
  await owner.getByRole('link', { name: 'Users' }).click();
  await owner.getByTestId('new-user').click();
  await owner.getByLabel('Name').fill('Cook');
  await owner.getByLabel('PIN (optional)').fill('5555');
  await owner.getByRole('checkbox', { name: 'Kitchen', exact: true }).check();
  await owner.getByRole('button', { name: 'Create user' }).click();
  await owner.getByTestId('dismiss-code').click();

  // Waiter: open the shift, take table T1's order, send it.
  await pinLogin(till, 'Kamal Cashier', '4321');
  await till.getByTestId('float').fill('0');
  await till.getByTestId('open-shift-btn').click();
  await till.getByTestId('tab-tables').click();
  await till.locator('[data-table="T1"]').click();
  await till.locator('[data-product="Latte"]').click();
  await expect(till.getByTestId('modifiers-done')).toBeDisabled();
  await till.locator('[data-option="Large"]').click();
  await till.getByTestId('modifiers-done').click();
  await till.locator('[data-product="Tea"]').click();
  await expect(till.getByTestId('order-total')).toHaveText('950.00');
  await till.getByTestId('send').click();
  await expect(till.locator('[data-line="Latte"] [data-status="SENT"]')).toBeVisible();

  // Cook signs in on the same till and lands on the kitchen display.
  await till.getByRole('button', { name: '← Tables' }).click();
  await till.getByRole('button', { name: 'Lock' }).click();
  await pinLogin(till, 'Cook', '5555');
  const ticket = till.locator('[data-ticket="T1"]');
  await expect(ticket).toContainText('Large');
  await ticket.locator('[data-item="Latte"]').click();
  await expect(ticket.locator('[data-item="Latte"]')).toHaveAttribute('data-status', 'PREPARING');
  await ticket.locator('[data-item="Latte"]').click();
  await expect(ticket.locator('[data-item="Latte"]')).toHaveAttribute('data-status', 'READY');
  await till.getByRole('button', { name: 'Lock' }).click();

  // Waiter: the latte is ready; guest one pays for it by card with a 10% tip, guest two the tea in cash.
  await pinLogin(till, 'Kamal Cashier', '4321');
  await till.getByTestId('tab-tables').click();
  await expect(till.locator('[data-table="T1"]')).toContainText('1 ready');
  await till.locator('[data-table="T1"]').click();
  await till.getByTestId('split').click();
  await till.locator('[data-split="Latte"]').check();
  await expect(till.getByTestId('order-total')).toHaveText('650.00');
  await till.getByTestId('pay-order').click();
  await till.getByRole('button', { name: '10%' }).click();
  await till.locator('[data-method="CARD"]').click();
  await till.getByTestId('complete').click();
  await expect(till.getByText('Paid 715.00')).toBeVisible();

  await till.getByTestId('pay-order').click();
  await till.getByTestId('complete').click();
  await expect(till.getByTestId('order-closed')).toBeVisible();

  await owner.getByRole('link', { name: 'Reports' }).click();
  await owner.getByRole('button', { name: 'Today' }).click();
  await expect(owner.getByTestId('net-sales')).toHaveText('950.00');
  await expect(owner.getByText('Tips (not revenue)')).toBeVisible();

  await shop.close();
});
