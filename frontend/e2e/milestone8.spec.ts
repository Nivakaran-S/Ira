import { expect, type Page, test } from '@playwright/test';
import { approveAsManager, openShop, pinLogin, setUpCatalog } from './flows';

/**
 * Stands in for the hardware bridge on 127.0.0.1:47800 with a sandbox card terminal that approves
 * everything (the real bridge and its sandbox terminal have their own tests). Returns what was asked of it.
 */
async function fakeBridge(till: Page) {
  let deviceId: string | null = null;
  till.on('request', (r) => {
    deviceId ??= r.headers()['x-device-id'] ?? null;
  });
  const calls: { path: string; body: { amount?: number; reference?: string } }[] = [];
  let n = 0;
  await till.context().route('http://127.0.0.1:47800/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const cors = { 'access-control-allow-origin': req.headers()['origin'] ?? '*', 'access-control-allow-headers': '*', 'access-control-allow-private-network': 'true' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (body: unknown) => route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (path === '/health') return json({ ok: true, paired: deviceId, printer: 'console', scale: null, terminal: 'sandbox' });
    const body = req.postData() ? JSON.parse(req.postData()!) : {};
    calls.push({ path, body });
    if (path.startsWith('/terminal/')) {
      n++;
      return json({ status: 'APPROVED', reference: body.reference, amount: body.amount, currency: body.currency, authCode: `00000${n}`, scheme: 'VISA', last4: '4242', terminalRef: `term-${n}-${Date.now()}` });
    }
    return json({ printed: 1 });
  });
  return calls;
}

test('Milestone 8: a whole shift offline with a customer, terminal cards, refund, void and close; the owner pays an invoice online', async ({ browser }) => {
  const shop = await openShop(browser, 'm8', 'Retail');
  const { owner, till, console: consolePage } = shop;
  const tenantName = `Shop ${shop.slug.replace(/^e2e-/, '')}`;
  await setUpCatalog(owner, [{ name: 'Ceylon tea', price: '500' }]);

  // Back office: refunds up to 5,000 offline, and a customer with 500 points.
  await owner.getByRole('link', { name: 'Settings' }).click();
  await owner.getByLabel('Largest refund offline').fill('5000');
  await owner.getByLabel('Largest refund offline').blur();
  await owner.getByRole('button', { name: 'Save settings' }).click();
  await expect(owner.getByText('Settings saved')).toBeVisible();
  await owner.getByRole('link', { name: 'Customers' }).click();
  await owner.getByTestId('new-customer').click();
  await owner.getByLabel('Name').fill('Kumari Perera');
  await owner.getByLabel('Phone').fill('0712345678');
  await owner.getByRole('button', { name: 'Save' }).click();
  await expect(owner.getByText('Customer added')).toBeVisible();
  await owner.locator('[data-customer="Kumari Perera"]').getByRole('link', { name: 'Open' }).click();
  await owner.getByLabel('Points change').fill('500');
  await owner.getByLabel('Points reason').fill('Welcome gift');
  await owner.getByRole('button', { name: 'Adjust' }).first().click();
  await expect(owner.getByTestId('points')).toHaveText('500');

  const bridge = await fakeBridge(till);
  // Online once, so both PINs can be checked on the till later; the till syncs the customer.
  await pinLogin(till, 'Sara Manager', '2468');
  await expect(till.getByTestId('open-shift')).toBeVisible();
  await till.getByRole('button', { name: 'Lock' }).click();
  await pinLogin(till, 'Kamal Cashier', '4321');
  await expect(till.getByTestId('online')).toBeVisible();

  // ── The network goes away before the shift is even open ─────────────────────────────
  await till.context().setOffline(true);
  await expect(till.getByTestId('open-shift')).toBeVisible();
  await till.getByTestId('float').fill('1000');
  await till.getByTestId('open-shift-btn').click();
  await expect(till.getByTestId('shift-open')).toBeVisible();
  await expect(till.getByTestId('offline')).toBeVisible();

  // Sale 1: two teas for Kumari, 500 in points and the rest on the card terminal.
  await till.locator('[data-product="Ceylon tea"]').click();
  await till.locator('[data-product="Ceylon tea"]').click();
  await till.getByTestId('add-customer-btn').click();
  await till.getByTestId('customer-q').fill('5678');
  await till.getByRole('button', { name: 'Find' }).click();
  await till.locator('[data-customer="Kumari Perera"]').click();
  await expect(till.getByTestId('cart-customer')).toContainText('500 pts');
  await till.getByTestId('pay').click();
  await till.locator('[data-method="LOYALTY"]').click();
  await till.getByRole('button', { name: 'Add as part payment' }).click();
  await till.locator('[data-method="CARD"]').click();
  await expect(till.getByTestId('terminal-note')).toBeVisible();
  await till.getByTestId('complete').click();
  await expect(till.getByTestId('sold-offline')).toBeVisible();
  await expect(till.getByTestId('receipt-no-done')).toHaveText('Receipt T1-O000001');
  await expect(till.getByTestId('sale-complete')).toContainText('VISA ****4242');
  await till.getByTestId('new-sale').click();
  expect(bridge.filter((c) => c.path === '/terminal/sale').map((c) => c.body.amount)).toEqual([50_000]);

  // Sale 2: one tea, cash.
  await till.locator('[data-product="Ceylon tea"]').click();
  await till.getByTestId('pay').click();
  await till.getByTestId('complete').click();
  await expect(till.getByTestId('receipt-no-done')).toHaveText('Receipt T1-O000002');
  await till.getByTestId('new-sale').click();

  // Refund one tea of sale 1 in cash, found in the till's journal; Sara approves.
  await till.getByTestId('tab-refund').click();
  await till.getByTestId('receipt-no').fill('T1-O000001');
  await till.getByRole('button', { name: 'Find' }).click();
  await till.locator('[data-refund-line="Ceylon tea"]').fill('1');
  await till.getByRole('combobox').selectOption('CASH');
  await till.getByTestId('refund-reason').fill('Changed mind');
  await till.getByTestId('do-refund').click();
  await approveAsManager(till);
  await expect(till.getByText(/Refunded 500\.00 \(T1-O000003\), offline/)).toBeVisible();

  // Void sale 2 from the till's own history; Sara approves.
  await till.getByTestId('tab-sales').click();
  await till.locator('[data-receipt="T1-O000002"]').getByRole('button', { name: 'Open' }).click();
  await till.getByTestId('void').click();
  await till.getByTestId('void-reason').fill('Rang up twice');
  await till.getByTestId('confirm-void').click();
  await approveAsManager(till);
  await expect(till.getByText('Sale T1-O000002 voided')).toBeVisible();

  // Close the shift offline: 1,000 float + 500 cash − 500 void − 500 refund = 500 expected.
  await till.getByTestId('tab-shift').click();
  await expect(till.getByTestId('expected-cash')).toHaveText('500.00');
  await till.getByTestId('counted').fill('500');
  await till.getByTestId('close-shift').click();
  await approveAsManager(till);
  await expect(till.getByTestId('variance')).toHaveText('0.00');
  await expect(till.getByTestId('outbox')).toHaveText('6 to sync');

  // ── The network comes back: everything reaches the server, nothing is held ──────────
  await till.context().setOffline(false);
  await expect(till.getByTestId('outbox')).toBeHidden({ timeout: 60_000 });

  await owner.getByRole('link', { name: 'Offline review' }).click();
  await expect(owner.getByText('Nothing here')).toBeVisible();
  await owner.getByRole('link', { name: 'Shifts' }).click();
  // Closed, and the server's own expected cash agrees with the till: 500 expected, 500 counted, no variance.
  await expect(owner.locator('tbody tr').first()).toContainText(/500\.00\s*500\.00\s*0\.00/);
  await owner.getByRole('link', { name: 'Sales', exact: true }).click();
  await owner.getByRole('button', { name: 'Search' }).click();
  await expect(owner.locator('tr', { hasText: 'T1-O000002' })).toContainText(/void/i);
  await owner.getByRole('link', { name: 'Customers' }).click();
  await owner.locator('[data-customer="Kumari Perera"]').getByRole('link', { name: 'Open' }).click();
  // 500 − 500 redeemed + 5 earned on the 500 paid by card, less the share refunded (3 of 5).
  await expect(owner.getByTestId('points')).toHaveText('2');

  // ── Billing: a paid plan, an invoice, and the owner pays it on the gateway's page ───
  await consolePage.getByRole('link', { name: 'Plans' }).click();
  await consolePage.getByTestId('new-plan').click();
  const pf = consolePage.getByTestId('plan-form');
  await pf.getByLabel('Key').fill(`m8-${Date.now().toString(36)}`);
  await pf.getByLabel('Name').fill('Retail plus');
  await pf.getByLabel('Monthly price').fill('9000');
  await pf.getByLabel('Stores').fill('5');
  await pf.getByLabel('Devices').fill('10');
  await pf.getByLabel('Users').fill('20');
  await pf.getByLabel('Products').fill('1000');
  await pf.getByRole('button', { name: 'Save plan' }).click();
  await expect(consolePage.getByText('Plan saved')).toBeVisible();
  await consolePage.getByRole('link', { name: 'Tenants' }).click();
  await consolePage.getByRole('link', { name: tenantName }).click();
  await consolePage.getByTestId('tenant-billing').getByLabel('Plan').selectOption({ label: 'Retail plus' });
  await expect(consolePage.getByText('Plan changed')).toBeVisible();
  await consolePage.getByRole('link', { name: 'Invoices' }).click();
  await consolePage.getByTestId('run-billing').click();

  await owner.getByRole('link', { name: 'Plan and billing' }).click();
  await owner.getByTestId('pay-invoice').click();
  await expect(owner.getByText('Sandbox payment gateway')).toBeVisible();
  await expect(owner.getByRole('heading', { name: /Pay 9,000\.00 LKR/ })).toBeVisible();
  await owner.getByRole('button', { name: 'Pay now' }).click();
  await expect(owner.getByTestId('payment-success')).toBeVisible();
  await expect(owner.getByText('PAID')).toBeVisible();

  await shop.close();
});
