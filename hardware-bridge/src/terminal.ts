import { randomInt, randomUUID } from 'node:crypto';

/** What a card terminal reports back for a charge or a refund. */
export interface TerminalResult {
  status: 'APPROVED' | 'DECLINED' | 'CANCELLED';
  /** The till's reference for this request; asking again with it returns the same result. */
  reference: string;
  amount: number;
  currency: string;
  /** Issuer approval code, printed on the receipt. */
  authCode?: string;
  scheme?: string;
  last4?: string;
  /** The terminal's own transaction id, needed to reverse or refund it later. */
  terminalRef?: string;
  message?: string;
}

export interface TerminalRequest {
  amount: number;
  currency: string;
  reference: string;
  /** Refunds: the charge being refunded, when the terminal can link them. */
  originalRef?: string;
}

/**
 * A payment terminal driven by the till (ECR integration). Implementations talk to the device;
 * the bridge exposes them to the paired till only. Each request carries a reference, and asking
 * again with the same reference must never charge twice: the terminal returns the first result.
 */
export interface CardTerminal {
  readonly kind: string;
  sale(req: TerminalRequest): Promise<TerminalResult>;
  refund(req: TerminalRequest): Promise<TerminalResult>;
}

export type TerminalConfig =
  | { type: 'none' }
  /** Simulated terminal for development and tests: approves, except amounts ending in 13 minor units. */
  | { type: 'sandbox'; delayMs?: number };

/**
 * Development and tests. Approves every request except amounts whose last two minor-unit digits
 * are 13 (declined, "Do not honour"), so both paths can be exercised by choosing the price.
 */
export class SandboxTerminal implements CardTerminal {
  readonly kind = 'sandbox';
  private readonly done = new Map<string, TerminalResult>();
  constructor(private readonly delayMs = 300) {}

  private async run(kind: 'sale' | 'refund', req: TerminalRequest): Promise<TerminalResult> {
    const key = `${kind}:${req.reference}`;
    const seen = this.done.get(key);
    if (seen) return seen;
    await new Promise((r) => setTimeout(r, this.delayMs));
    const declined = kind === 'sale' && req.amount % 100 === 13;
    const result: TerminalResult = declined
      ? { status: 'DECLINED', reference: req.reference, amount: req.amount, currency: req.currency, message: 'Do not honour' }
      : {
          status: 'APPROVED', reference: req.reference, amount: req.amount, currency: req.currency,
          authCode: String(randomInt(0, 1_000_000)).padStart(6, '0'), scheme: 'VISA', last4: '4242', terminalRef: randomUUID(),
        };
    this.done.set(key, result);
    return result;
  }

  sale(req: TerminalRequest) {
    return this.run('sale', req);
  }
  refund(req: TerminalRequest) {
    return this.run('refund', req);
  }
}

export function createTerminal(cfg: TerminalConfig | undefined): CardTerminal | null {
  switch (cfg?.type) {
    case 'sandbox':
      return new SandboxTerminal(cfg.delayMs);
    default:
      return null;
  }
}

/** Checks a request body from the till. */
export function parseTerminalRequest(v: unknown): TerminalRequest | null {
  const r = v as Partial<TerminalRequest>;
  if (typeof r !== 'object' || r === null) return null;
  if (!Number.isInteger(r.amount) || (r.amount as number) < 1 || (r.amount as number) > 100_000_000_000) return null;
  if (typeof r.currency !== 'string' || !/^[A-Z]{3}$/.test(r.currency)) return null;
  if (typeof r.reference !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(r.reference)) return null;
  if (r.originalRef !== undefined && (typeof r.originalRef !== 'string' || r.originalRef.length > 64)) return null;
  return { amount: r.amount as number, currency: r.currency, reference: r.reference, ...(r.originalRef ? { originalRef: r.originalRef } : {}) };
}
