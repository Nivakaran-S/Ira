import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ReceiptDoc } from '@pos/shared';
import { type DevicePublicJwk, type PairingCode, type PairingStore, SignatureVerifier } from './auth.js';
import type { Printer } from './devices.js';
import { DRAWER_KICK, receiptText, renderReceipt } from './escpos.js';
import type { Scale } from './scale.js';
import { type CardTerminal, parseTerminalRequest } from './terminal.js';

export interface BridgeOptions {
  printer: Printer | null;
  scale: Scale | null;
  terminal?: CardTerminal | null;
  pairing: PairingStore;
  pairingCode: PairingCode;
  /** Exact origins allowed to call the bridge; empty = any (signatures still required). */
  allowedOrigins: string[];
  log?: (msg: string) => void;
}

const MAX_BODY = 256 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isReceipt(v: unknown): v is ReceiptDoc {
  const d = v as ReceiptDoc;
  const strs = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === 'string');
  const rows = (a: unknown) => Array.isArray(a) && a.every((x) => typeof x === 'object' && x !== null);
  return (
    typeof d === 'object' && d !== null && typeof d.title === 'string' && strs(d.header) && strs(d.footer) &&
    rows(d.meta) && rows(d.lines) && rows(d.totals) && rows(d.taxes) && rows(d.payments) && d.lines.length <= 1000
  );
}

export function createBridgeServer(opts: BridgeOptions): Server {
  const verifier = new SignatureVerifier(opts.pairing);
  const log = opts.log ?? (() => undefined);

  const cors = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (opts.allowedOrigins.length && !opts.allowedOrigins.includes(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-device-id, x-device-ts, x-device-nonce, x-device-sig');
    // Chrome's Private Network Access: a public site calling 127.0.0.1 must be allowed explicitly.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  return createServer(async (req, res) => {
    try {
      if (!cors(req, res)) return send(res, 403, { code: 'ORIGIN_NOT_ALLOWED' });
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname + url.search;
      const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          ok: true,
          paired: opts.pairing.get()?.deviceId ?? null,
          printer: opts.printer ? opts.printer.kind : null,
          scale: opts.scale ? opts.scale.kind : null,
          terminal: opts.terminal ? opts.terminal.kind : null,
        });
      }

      if (req.method === 'POST' && url.pathname === '/pair') {
        // The new key signs its own pairing request, and the operator types the code shown on the bridge.
        let input: { deviceId?: string; publicKeyJwk?: DevicePublicJwk; code?: string };
        try {
          input = JSON.parse(body.toString('utf8'));
        } catch {
          return send(res, 400, { code: 'VALIDATION_FAILED' });
        }
        const jwk = input.publicKeyJwk;
        if (!input.deviceId || !jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof input.code !== 'string') return send(res, 400, { code: 'VALIDATION_FAILED' });
        const probe = new SignatureVerifier({ get: () => ({ deviceId: input.deviceId!, publicKeyJwk: jwk, pairedAt: '' }) } as PairingStore);
        if (!(await probe.verify('POST', path, body, req.headers))) return send(res, 401, { code: 'DEVICE_SIGNATURE_INVALID' });
        if (!opts.pairingCode.consume(input.code)) return send(res, 401, { code: 'PAIRING_CODE_INVALID' });
        await opts.pairing.set({ deviceId: input.deviceId, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, pairedAt: new Date().toISOString() });
        log(`Paired with device ${input.deviceId}`);
        return send(res, 200, { paired: input.deviceId });
      }

      if (!(await verifier.verify(req.method ?? 'GET', path, body, req.headers))) return send(res, 401, { code: 'DEVICE_SIGNATURE_INVALID' });

      if (req.method === 'POST' && url.pathname === '/print') {
        if (!opts.printer) return send(res, 503, { code: 'NO_PRINTER' });
        let input: { receipt?: unknown; openDrawer?: boolean; copies?: number };
        try {
          input = JSON.parse(body.toString('utf8'));
        } catch {
          return send(res, 400, { code: 'VALIDATION_FAILED' });
        }
        if (!isReceipt(input.receipt)) return send(res, 400, { code: 'VALIDATION_FAILED', message: 'receipt must be a ReceiptDoc' });
        const copies = Math.min(Math.max(1, Math.trunc(input.copies ?? 1)), 3);
        for (let i = 0; i < copies; i++) {
          const bytes = renderReceipt(input.receipt, { columns: opts.printer.columns, openDrawer: i === 0 && input.openDrawer === true });
          await opts.printer.write(bytes, receiptText(input.receipt, opts.printer.columns));
        }
        return send(res, 200, { printed: copies });
      }

      if (req.method === 'POST' && url.pathname === '/drawer/open') {
        if (!opts.printer) return send(res, 503, { code: 'NO_PRINTER' });
        await opts.printer.write(DRAWER_KICK, '[drawer opened]');
        return send(res, 200, { opened: true });
      }

      if (req.method === 'GET' && url.pathname === '/scale/weight') {
        if (!opts.scale) return send(res, 503, { code: 'NO_SCALE' });
        return send(res, 200, await opts.scale.read());
      }

      if (req.method === 'POST' && (url.pathname === '/terminal/sale' || url.pathname === '/terminal/refund')) {
        if (!opts.terminal) return send(res, 503, { code: 'NO_TERMINAL' });
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return send(res, 400, { code: 'VALIDATION_FAILED' });
        }
        const input = parseTerminalRequest(parsed);
        if (!input) return send(res, 400, { code: 'VALIDATION_FAILED', message: 'amount, currency and reference required' });
        const result = url.pathname === '/terminal/sale' ? await opts.terminal.sale(input) : await opts.terminal.refund(input);
        log(`terminal ${url.pathname.slice(10)} ${input.reference}: ${result.status}`);
        return send(res, 200, result);
      }

      return send(res, 404, { code: 'NOT_FOUND' });
    } catch (e) {
      log(`error: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 502, { code: 'DEVICE_ERROR', message: (e as Error).message });
    }
  });
}
