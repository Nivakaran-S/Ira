import { inject, Injectable, signal } from '@angular/core';
import type { CardResult, ReceiptDoc } from '@pos/shared';
import { signRequest } from '../device/device-signer';
import { PosSession } from '../device/pos-session';

export const BRIDGE_URL = 'http://127.0.0.1:47800';

export interface BridgeHealth {
  ok: boolean;
  paired: string | null;
  printer: string | null;
  scale: string | null;
  terminal?: string | null;
}

export interface TerminalResult {
  status: 'APPROVED' | 'DECLINED' | 'CANCELLED';
  reference: string;
  amount: number;
  authCode?: string;
  scheme?: string;
  last4?: string;
  terminalRef?: string;
  message?: string;
}

export class TerminalError extends Error {}

/** What the API keeps of an approved terminal result. */
export function cardOf(r: TerminalResult): CardResult {
  return { scheme: r.scheme ?? 'CARD', last4: r.last4 ?? '0000', authCode: r.authCode ?? '', terminalRef: r.terminalRef ?? r.reference };
}

export type PrintResult = 'bridge' | 'browser';

/**
 * The local hardware bridge (receipt printer, cash drawer, scale). Every call is signed with this
 * till's device key; the bridge only obeys the device it was paired with. When the bridge is not
 * running the till falls back to the browser's print dialog.
 */
@Injectable({ providedIn: 'root' })
export class HardwareBridge {
  private readonly session = inject(PosSession);
  readonly health = signal<BridgeHealth | null>(null);

  async check(): Promise<BridgeHealth | null> {
    try {
      const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(1_500) });
      const h = (await res.json()) as BridgeHealth;
      this.health.set(h);
      return h;
    } catch {
      this.health.set(null);
      return null;
    }
  }

  /** True when the bridge is up and paired with this device. */
  ready(): boolean {
    const h = this.health();
    return !!h && h.paired === this.session.device()?.deviceId;
  }

  /** A card terminal is attached to the paired bridge. */
  hasTerminal(): boolean {
    return this.ready() && !!this.health()?.terminal;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10_000): Promise<Response> {
    const device = this.session.device();
    if (!device) throw new Error('Till not enrolled');
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = await signRequest(device.privateKey, device.deviceId, method, path, text);
    return fetch(BRIDGE_URL + path, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : text,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /**
   * Charges or refunds on the terminal. The customer may take a while at the terminal, so this waits
   * up to two minutes. A lost answer is asked for again with the same reference, which the terminal
   * answers with its first result instead of charging twice.
   */
  async terminal(kind: 'sale' | 'refund', amount: number, currency: string, reference: string, originalRef?: string): Promise<TerminalResult> {
    if (!this.hasTerminal() && !(await this.check(), this.hasTerminal())) throw new TerminalError('No card terminal is connected to this till.');
    const body = { amount, currency, reference, ...(originalRef ? { originalRef } : {}) };
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.call('POST', `/terminal/${kind}`, body, 120_000);
        if (!res.ok) throw new TerminalError(`The card terminal reported an error (${res.status}).`);
        return (await res.json()) as TerminalResult;
      } catch (e) {
        if (e instanceof TerminalError) throw e;
        lastError = e;
      }
    }
    throw new TerminalError(`The card terminal did not answer: ${(lastError as Error)?.message ?? 'no response'}. Check the terminal before trying again.`);
  }

  async pair(code: string): Promise<void> {
    const device = this.session.device();
    if (!device) throw new Error('Till not enrolled');
    const jwk = await crypto.subtle.exportKey('jwk', device.publicKey);
    const res = await this.call('POST', '/pair', { deviceId: device.deviceId, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, code: code.trim() });
    if (!res.ok) throw new Error(res.status === 401 ? 'Wrong or expired pairing code' : `Bridge error ${res.status}`);
    await this.check();
  }

  /** Prints on the receipt printer, or opens the browser print dialog if the bridge is not available. */
  async print(receipt: ReceiptDoc, openDrawer = false): Promise<PrintResult> {
    if (this.ready() || (await this.check(), this.ready())) {
      try {
        const res = await this.call('POST', '/print', { receipt, openDrawer });
        if (res.ok) return 'bridge';
      } catch {
        // fall through to the browser
      }
    }
    printInBrowser(receipt);
    return 'browser';
  }

  async openDrawer(): Promise<boolean> {
    if (!this.ready() && !(await this.check(), this.ready())) return false;
    try {
      return (await this.call('POST', '/drawer/open', {})).ok;
    } catch {
      return false;
    }
  }

  /** Grams on the scale, or null when there is no scale or it is not settled. */
  async weigh(): Promise<{ grams: number; stable: boolean } | null> {
    if (!this.ready() && !(await this.check(), this.ready())) return null;
    try {
      const res = await this.call('GET', '/scale/weight');
      return res.ok ? ((await res.json()) as { grams: number; stable: boolean }) : null;
    } catch {
      return null;
    }
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 80 mm-wide HTML rendering of a receipt, for the browser fallback and on-screen previews. */
export function receiptHtml(r: ReceiptDoc): string {
  const row = (l: string, v: string, bold = false) => `<div class="r${bold ? ' b' : ''}"><span>${esc(l)}</span><span>${esc(v)}</span></div>`;
  return `
    <div class="rcpt">
      ${r.header.map((h, i) => `<div class="c${i === 0 ? ' h' : ''}">${esc(h)}</div>`).join('')}
      <div class="c b t">${esc(r.title)}</div>
      ${r.meta.map((m) => row(m.label, m.value)).join('')}
      <hr />
      ${r.lines
        .map(
          (l) => `<div>${esc(l.name)}</div>${row(`  ${l.qty} x ${l.unitPrice}`, l.total)}${l.discount ? row('  Discount', l.discount) : ''}${l.note ? `<div class="n">${esc(l.note)}</div>` : ''}`,
        )
        .join('')}
      <hr />
      ${r.totals.map((t) => row(t.label, t.value, t.bold)).join('')}
      ${r.taxes.length ? '<br />' + r.taxes.map((t) => row(t.label, t.value)).join('') : ''}
      ${r.payments.length ? '<br />' + r.payments.map((p) => row(p.label, p.value)).join('') : ''}
      <br />
      ${r.footer.map((f) => `<div class="c">${esc(f)}</div>`).join('')}
      ${r.barcode ? `<div class="c bc">${esc(r.barcode)}</div>` : ''}
    </div>`;
}

export const RECEIPT_CSS = `
  .rcpt { font: 12px/1.35 ui-monospace, Consolas, monospace; width: 72mm; color: #000; }
  .rcpt .c { text-align: center; } .rcpt .h { font-size: 16px; font-weight: 700; } .rcpt .b { font-weight: 700; }
  .rcpt .t { margin: 6px 0; } .rcpt .r { display: flex; justify-content: space-between; gap: 8px; white-space: pre; }
  .rcpt .n { padding-left: 2ch; font-style: italic; } .rcpt hr { border: none; border-top: 1px dashed #000; }
  .rcpt .bc { letter-spacing: 2px; margin-top: 6px; }
`;

function printInBrowser(r: ReceiptDoc) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(`<!doctype html><html><head><title>Receipt</title><style>@page{size:80mm auto;margin:4mm}body{margin:0}${RECEIPT_CSS}</style></head><body>${receiptHtml(r)}</body></html>`);
  doc.close();
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  setTimeout(() => frame.remove(), 60_000);
}

