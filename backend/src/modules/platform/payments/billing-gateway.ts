/**
 * A hosted-checkout payment gateway for invoices. The owner is sent to the gateway's page to pay;
 * the gateway tells us the outcome with a signed webhook. Card details never touch this server.
 *
 * Implementations: `SandboxGateway` (development and tests) and `PayHereGateway`. To add another,
 * implement this interface, verify its webhook signature in `parseWebhook`, add its key to
 * BILLING_GATEWAY in config/env.ts and provide it in platform.module.ts.
 */
export interface BillingGateway {
  /** Stored on each payment attempt, and the `:provider` in the webhook URL. */
  readonly key: string;
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  /** The event in a webhook body, or null when its signature does not verify. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): GatewayEvent | null;
}

export interface CheckoutInput {
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  /** Path on the tenant's host to come back to after paying. */
  returnPath: string;
  /** The tenant's origin as the payer's browser sees it, e.g. https://acme.pos.lk. */
  origin: string;
  payer: { name: string; email: string; phone?: string; business: string };
}

export interface CheckoutSession {
  sessionId: string;
  /** Where to send the payer's browser. */
  url: string;
  /** When set, the browser POSTs these fields to `url` as a form (PayHere); otherwise it just goes to `url`. */
  fields?: Record<string, string>;
}

export interface GatewayEvent {
  sessionId: string;
  /** PENDING: the provider is still waiting (e.g. a bank transfer); nothing changes yet. */
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING';
  amount: number;
  currency: string;
  providerRef?: string;
  failureReason?: string;
}

export const BILLING_GATEWAY = Symbol('BILLING_GATEWAY');
