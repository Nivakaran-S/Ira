import { createHash, randomUUID, webcrypto } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { buildSigningPayload, type ReceiptDoc } from '@pos/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PairingCode, PairingStore } from './auth.js';
import { MemoryPrinter } from './devices.js';
import { renderReceipt, twoCol, wrap } from './escpos.js';
import { FixedScale } from './scale.js';
import { createBridgeServer } from './server.js';
import { SandboxTerminal } from './terminal.js';

const receipt: ReceiptDoc = {
  currency: 'LKR',
  header: ['Acme Cafe', 'Colombo 03'],
  title: 'RECEIPT',
  meta: [{ label: 'Receipt', value: 'T1-000001' }],
  lines: [{ name: 'Iced coffee with oat milk', qty: '2', unitPrice: '850.00', total: '1,700.00' }],
  totals: [{ label: 'TOTAL LKR', value: '1,700.00', bold: true }],
  taxes: [{ label: 'VAT 18% (incl.)', value: '254.00' }],
  payments: [
    { label: 'Cash', value: '2,000.00' },
    { label: 'Change', value: '300.00' },
  ],
  footer: ['Thank you!'],
  barcode: 'T1-000001',
};

describe('escpos', () => {
  it('lays out two columns and wraps', () => {
    expect(twoCol('Total', '1,700.00', 20)).toBe('Total       1,700.00');
    expect(twoCol('A very long product name', '9.00', 16)).toBe('A very long 9.00');
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('renders init, text, barcode, cut and an optional drawer kick', () => {
    const bytes = renderReceipt(receipt, { columns: 32, openDrawer: true });
    expect([...bytes.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect(bytes.includes(Buffer.from('Iced coffee with oat milk'))).toBe(true);
    expect(bytes.includes(Buffer.from([0x1d, 0x6b, 73]))).toBe(true);
    expect(bytes.includes(Buffer.from([0x1d, 0x56, 66, 0]))).toBe(true);
    expect([...bytes.subarray(-5)]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    expect(renderReceipt(receipt, { columns: 32 }).includes(Buffer.from([0x1b, 0x70]))).toBe(false);
  });

  it('never emits non-ASCII bytes from text', () => {
    const bytes = renderReceipt({ ...receipt, lines: [{ name: 'Café ☕', qty: '1', unitPrice: '1', total: '1' }] }, { columns: 32 });
    expect(bytes.includes(Buffer.from('Cafe ?'))).toBe(true);
  });
});

describe('bridge server', () => {
  let base: string;
  let printer: MemoryPrinter;
  let code: PairingCode;
  let close: () => Promise<void>;
  let keys: CryptoKeyPair;
  let jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  const deviceId = randomUUID();

  beforeEach(async () => {
    printer = new MemoryPrinter(32);
    code = new PairingCode();
    const server = createBridgeServer({
      printer, scale: new FixedScale(1234), terminal: new SandboxTerminal(0), pairing: new PairingStore(null), pairingCode: code, allowedOrigins: ['https://acme.pos.localhost'],
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
    keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const e = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
    jwk = { kty: 'EC', crv: 'P-256', x: e.x!, y: e.y! };
  });
  afterEach(() => close());

  async function signed(method: string, path: string, body?: unknown, key = keys.privateKey) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const payload = buildSigningPayload(method, path, createHash('sha256').update(text).digest('hex'), ts, nonce);
    const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(payload))).toString('base64url');
    return fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-device-id': deviceId, 'x-device-ts': ts, 'x-device-nonce': nonce, 'x-device-sig': sig },
      body: body === undefined ? undefined : text,
    });
  }

  const pair = (c: string) => signed('POST', '/pair', { deviceId, publicKeyJwk: jwk, code: c });

  it('reports health without a signature', async () => {
    const res = await fetch(`${base}/health`);
    expect(await res.json()).toEqual({ ok: true, paired: null, printer: 'memory', scale: 'fixed', terminal: 'sandbox' });
  });

  it('refuses to print before pairing and with a wrong code', async () => {
    expect((await signed('POST', '/print', { receipt })).status).toBe(401);
    const real = code.current();
    expect((await pair(real === '000000' ? '000001' : '000000')).status).toBe(401);
  });

  it('pairs with the code, then prints and kicks the drawer for that device only', async () => {
    expect((await pair(code.current())).status).toBe(200);
    expect((await pair(code.current())).status).toBe(200); // a fresh code re-pairs
    const res = await signed('POST', '/print', { receipt, openDrawer: true });
    expect(res.status).toBe(200);
    expect(printer.jobs).toHaveLength(1);
    expect(printer.jobs[0].preview).toContain('T1-000001');
    expect((await signed('POST', '/drawer/open', {})).status).toBe(200);
    expect(printer.jobs).toHaveLength(2);

    const other = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
    expect((await signed('POST', '/print', { receipt }, other.privateKey)).status).toBe(401);
    expect((await signed('POST', '/print', { receipt: { title: 1 } })).status).toBe(400);
    expect(await (await signed('GET', '/scale/weight')).json()).toEqual({ grams: 1234, stable: true });
  });

  it('charges and refunds on the terminal, once per reference, and declines amounts ending in 13', async () => {
    expect((await signed('POST', '/terminal/sale', { amount: 1000, currency: 'LKR', reference: 'sale-0000001' })).status).toBe(401);
    await pair(code.current());
    const first = await (await signed('POST', '/terminal/sale', { amount: 1000, currency: 'LKR', reference: 'sale-0000001' })).json();
    expect(first).toMatchObject({ status: 'APPROVED', amount: 1000, scheme: 'VISA', last4: '4242' });
    expect(first.authCode).toMatch(/^\d{6}$/);
    const again = await (await signed('POST', '/terminal/sale', { amount: 1000, currency: 'LKR', reference: 'sale-0000001' })).json();
    expect(again).toEqual(first);
    expect(await (await signed('POST', '/terminal/sale', { amount: 1013, currency: 'LKR', reference: 'sale-0000002' })).json()).toMatchObject({ status: 'DECLINED' });
    const refund = await (await signed('POST', '/terminal/refund', { amount: 500, currency: 'LKR', reference: 'refund-00001', originalRef: first.terminalRef })).json();
    expect(refund).toMatchObject({ status: 'APPROVED', amount: 500 });
    expect((await signed('POST', '/terminal/sale', { amount: -5, currency: 'LKR', reference: 'sale-0000003' })).status).toBe(400);
  });

  it('burns the pairing code after five wrong guesses', async () => {
    const real = code.current();
    const wrong = real === '999999' ? '999998' : '999999';
    for (let i = 0; i < 5; i++) await pair(wrong);
    expect((await pair(real)).status).toBe(401);
  });

  it('answers CORS preflight for allowed origins with private-network consent, refuses others', async () => {
    const ok = await fetch(`${base}/print`, { method: 'OPTIONS', headers: { origin: 'https://acme.pos.localhost' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-private-network')).toBe('true');
    const bad = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
  });
});

describe('scale frames', async () => {
  const { parseScaleFrame } = await import('./scale.js');
  it('reads common scale outputs', () => {
    expect(parseScaleFrame('ST,GS,+  1.250kg')).toEqual({ grams: 1250, stable: true });
    expect(parseScaleFrame('US,GS,+  0.980kg')).toEqual({ grams: 980, stable: false });
    expect(parseScaleFrame('W 01250 g')).toEqual({ grams: 1250, stable: true });
    expect(parseScaleFrame('  2,5 kg')).toEqual({ grams: 2500, stable: true });
    expect(parseScaleFrame('ERR')).toBeNull();
  });
});
