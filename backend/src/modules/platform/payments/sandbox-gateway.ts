import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BillingGateway, CheckoutInput, CheckoutSession, GatewayEvent } from './billing-gateway.js';

export const SANDBOX_SIGNATURE_HEADER = 'x-sandbox-signature';

/**
 * A pretend gateway for development and tests. Its "hosted page" is served by this backend
 * (`/api/billing/sandbox/checkout/:session`); choosing an outcome there produces a webhook signed
 * with a per-process secret and fed through the same verification a real provider's would.
 * Refused in production by the environment check.
 */
export class SandboxGateway implements BillingGateway {
  readonly key = 'sandbox';
  private readonly secret = randomBytes(32);
  /** Sessions waiting on the 3-D Secure code, per process like the signing secret. */
  private readonly challenges = new Map<string, { brand: string; last4: string; tries: number }>();

  constructor(readonly options: { webhookDelayMs: number } = { webhookDelayMs: 0 }) {}

  startChallenge(session: string, brand: string, last4: string) {
    this.challenges.set(session, { brand, last4, tries: 0 });
  }
  challenge(session: string) {
    return this.challenges.get(session);
  }
  /** Counts a wrong code; the third one ends the challenge. */
  failChallenge(session: string): 'retry' | 'locked' {
    const c = this.challenges.get(session);
    if (!c) return 'locked';
    c.tries += 1;
    if (c.tries >= 3) {
      this.challenges.delete(session);
      return 'locked';
    }
    return 'retry';
  }
  private readonly strikes = new Map<string, number>();
  /** Counts a declined card on this checkout; returns how many so far. */
  strike(session: string) {
    const n = (this.strikes.get(session) ?? 0) + 1;
    this.strikes.set(session, n);
    return n;
  }
  endChallenge(session: string) {
    this.challenges.delete(session);
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutSession> {
    const sessionId = `sbx_${randomBytes(12).toString('hex')}`;
    return { sessionId, url: `/api/billing/sandbox/checkout/${sessionId}?return=${encodeURIComponent(input.returnPath)}` };
  }

  /** What the sandbox page sends when the payer chooses an outcome. */
  webhook(event: GatewayEvent): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(JSON.stringify(event));
    return { body, headers: { [SANDBOX_SIGNATURE_HEADER]: this.sign(body) } };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): GatewayEvent | null {
    const sig = headers[SANDBOX_SIGNATURE_HEADER];
    if (typeof sig !== 'string') return null;
    const want = Buffer.from(this.sign(rawBody));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const e = JSON.parse(rawBody.toString('utf8')) as GatewayEvent;
    if (typeof e.sessionId !== 'string' || !['SUCCEEDED', 'FAILED'].includes(e.status) || !Number.isInteger(e.amount) || typeof e.currency !== 'string') return null;
    return e;
  }

  private sign(body: Buffer) {
    return createHmac('sha256', this.secret).update(body).digest('hex');
  }
}
