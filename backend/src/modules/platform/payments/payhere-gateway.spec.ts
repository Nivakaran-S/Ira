import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PayHereGateway } from './payhere-gateway.js';

const cfg = { merchantId: '1211149', merchantSecret: 'MjM0NTY3ODkwMTIzNDU2Nzg5', sandbox: true, notifyUrl: 'https://api.example.lk/api/platform/billing/webhooks/payhere' };
const gw = new PayHereGateway(cfg);
const MD5 = (s: string) => createHash('md5').update(s).digest('hex').toUpperCase();

/** A notification exactly as PayHere signs it (their documented formula, computed independently here). */
function notify(over: Record<string, string> = {}) {
  const f = { merchant_id: cfg.merchantId, order_id: 'ph0123456789abcdef0123', payment_id: '320025071278', payhere_amount: '15000.00', payhere_currency: 'LKR', status_code: '2', ...over };
  const sig = MD5(f.merchant_id + f.order_id + f.payhere_amount + f.payhere_currency + f.status_code + MD5(cfg.merchantSecret));
  return Buffer.from(new URLSearchParams({ ...f, md5sig: sig, ...(over['md5sig'] ? { md5sig: over['md5sig'] } : {}) }).toString());
}

describe('PayHere gateway', () => {
  it('builds a signed checkout form for the sandbox', async () => {
    const s = await gw.createCheckout({
      invoiceId: 'i', invoiceNumber: 'INV-202611-acme', amount: 1_500_000, currency: 'LKR', returnPath: '/billing', origin: 'https://acme.pos.lk',
      payer: { name: 'Nimal Perera', email: 'nimal@acme.lk', business: 'Acme Stores' },
    });
    expect(s.url).toBe('https://sandbox.payhere.lk/pay/checkout');
    expect(s.fields).toMatchObject({
      merchant_id: '1211149', order_id: s.sessionId, amount: '15000.00', currency: 'LKR', first_name: 'Nimal', last_name: 'Perera', email: 'nimal@acme.lk',
      return_url: 'https://acme.pos.lk/billing?payment=submitted', cancel_url: 'https://acme.pos.lk/billing?payment=cancelled', notify_url: cfg.notifyUrl,
    });
    expect(s.fields!['hash']).toBe(MD5(cfg.merchantId + s.sessionId + '15000.00' + 'LKR' + MD5(cfg.merchantSecret)));
    expect(new PayHereGateway({ ...cfg, sandbox: false }).createCheckout).toBeDefined();
  });

  it('reads signed notifications: paid, pending, failed; refuses bad signatures and other merchants', () => {
    expect(gw.parseWebhook(notify())).toEqual({ sessionId: 'ph0123456789abcdef0123', status: 'SUCCEEDED', amount: 1_500_000, currency: 'LKR', providerRef: '320025071278' });
    expect(gw.parseWebhook(notify({ status_code: '0' }))?.status).toBe('PENDING');
    expect(gw.parseWebhook(notify({ status_code: '-2' }))).toMatchObject({ status: 'FAILED', failureReason: 'Payment failed' });
    expect(gw.parseWebhook(notify({ md5sig: 'A'.repeat(32) }))).toBeNull();
    expect(gw.parseWebhook(notify({ merchant_id: '9999999' }))).toBeNull();
    // Changing the amount after signing breaks the signature.
    const tampered = Buffer.from(notify().toString().replace('15000.00', '1.00'));
    expect(gw.parseWebhook(tampered)).toBeNull();
  });
});
