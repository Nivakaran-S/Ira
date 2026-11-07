import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BillingGateway, CheckoutInput, CheckoutSession, GatewayEvent } from './billing-gateway.js';

export interface PayHereConfig {
  merchantId: string;
  merchantSecret: string;
  /** sandbox.payhere.lk (free test merchant accounts) instead of www.payhere.lk. */
  sandbox: boolean;
  /** Public URL PayHere posts payment notifications to: `<api>/api/platform/billing/webhooks/payhere`. */
  notifyUrl: string;
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex').toUpperCase();
/** PayHere amounts are major units with two decimals; LKR, USD and the rest it takes all have two. */
const major = (minor: number) => (minor / 100).toFixed(2);

/**
 * PayHere (Sri Lanka) hosted checkout. The browser posts a signed form to PayHere's checkout page;
 * PayHere posts the outcome to `notifyUrl`, signed with md5 over the fields and the merchant secret.
 * https://support.payhere.lk/api-&-mobile-sdk/checkout-api
 */
export class PayHereGateway implements BillingGateway {
  readonly key = 'payhere';
  constructor(private readonly cfg: PayHereConfig) {}

  private get secretHash() {
    return md5(this.cfg.merchantSecret);
  }

  /** hash = MD5(merchant_id + order_id + amount + currency + MD5(secret)), upper-case. */
  checkoutHash(orderId: string, amount: string, currency: string) {
    return md5(this.cfg.merchantId + orderId + amount + currency + this.secretHash);
  }

  /** md5sig = MD5(merchant_id + order_id + payhere_amount + payhere_currency + status_code + MD5(secret)), upper-case. */
  notifySignature(f: { orderId: string; amount: string; currency: string; statusCode: string }) {
    return md5(this.cfg.merchantId + f.orderId + f.amount + f.currency + f.statusCode + this.secretHash);
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const orderId = `ph${randomBytes(10).toString('hex')}`;
    const amount = major(input.amount);
    const [first, ...rest] = (input.payer.name || 'Owner').trim().split(/\s+/);
    return {
      sessionId: orderId,
      url: `https://${this.cfg.sandbox ? 'sandbox' : 'www'}.payhere.lk/pay/checkout`,
      fields: {
        merchant_id: this.cfg.merchantId,
        return_url: `${input.origin}${input.returnPath}?payment=submitted`,
        cancel_url: `${input.origin}${input.returnPath}?payment=cancelled`,
        notify_url: this.cfg.notifyUrl,
        order_id: orderId,
        items: `Invoice ${input.invoiceNumber}`,
        currency: input.currency,
        amount,
        first_name: first,
        last_name: rest.join(' ') || '-',
        email: input.payer.email,
        phone: input.payer.phone ?? '0000000000',
        address: input.payer.business,
        city: 'Colombo',
        country: 'Sri Lanka',
        hash: this.checkoutHash(orderId, amount, input.currency),
      },
    };
  }

  parseWebhook(rawBody: Buffer): GatewayEvent | null {
    const p = new URLSearchParams(rawBody.toString('utf8'));
    const f = {
      merchantId: p.get('merchant_id') ?? '', orderId: p.get('order_id') ?? '', paymentId: p.get('payment_id') ?? '',
      amount: p.get('payhere_amount') ?? '', currency: p.get('payhere_currency') ?? '', statusCode: p.get('status_code') ?? '', sig: p.get('md5sig') ?? '',
    };
    if (f.merchantId !== this.cfg.merchantId || !/^\d+\.\d{2}$/.test(f.amount) || !/^-?\d$/.test(f.statusCode)) return null;
    const want = Buffer.from(this.notifySignature(f));
    const got = Buffer.from(f.sig.toUpperCase());
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const amount = Math.round(Number(f.amount) * 100);
    const base = { sessionId: f.orderId, amount, currency: f.currency, providerRef: f.paymentId || undefined };
    switch (f.statusCode) {
      case '2':
        return { ...base, status: 'SUCCEEDED' };
      case '0':
        return { ...base, status: 'PENDING' };
      default:
        return { ...base, status: 'FAILED', failureReason: ({ '-1': 'Cancelled', '-2': 'Payment failed', '-3': 'Charged back' } as Record<string, string>)[f.statusCode] ?? `Status ${f.statusCode}` };
    }
  }
}
