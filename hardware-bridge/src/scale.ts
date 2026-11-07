import { connect } from 'node:net';

export interface WeightReading {
  /** Grams. */
  grams: number;
  stable: boolean;
}

export interface Scale {
  readonly kind: string;
  read(): Promise<WeightReading>;
}

export type ScaleConfig =
  | { type: 'none' }
  | { type: 'fixed'; grams: number }
  /** A scale on the network that answers a weight request (many retail scales expose TCP). */
  | { type: 'tcp'; host: string; port: number; request?: string }
  /** A serial (RS-232/USB-serial) scale; needs the optional `serialport` package on the till. */
  | { type: 'serial'; path: string; baudRate?: number; request?: string };

/**
 * Reads the weight out of the text scales send. Handles the common continuous formats:
 * "ST,GS,+  1.250kg" (stable/unstable, gross), "  1.250 kg", "W 01250 g", "US,GS,  0.98kg".
 * Returns null when nothing weight-like is in the frame.
 */
export function parseScaleFrame(frame: string): WeightReading | null {
  const text = frame.replace(/[\x00-\x1f]/g, ' ').trim();
  const m = text.match(/([+-]?\s*\d+(?:[.,]\d+)?)\s*(kg|g|lb)\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(/\s+/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = m[2].toLowerCase();
  const grams = Math.round(unit === 'kg' ? n * 1000 : unit === 'lb' ? n * 453.59237 : n);
  const unstable = /\b(US|M|MOTION)\b/i.test(text) || text.includes('?');
  return { grams, stable: !unstable };
}

/** Development and tests: always reports the same stable weight. */
export class FixedScale implements Scale {
  readonly kind = 'fixed';
  constructor(private grams: number) {}
  set(grams: number) {
    this.grams = grams;
  }
  async read() {
    return { grams: this.grams, stable: true };
  }
}

/** Collects what the scale sends until a frame parses, or times out. */
function firstReading(onData: (cb: (chunk: Buffer) => void) => void, timeoutMs: number): Promise<WeightReading> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Scale did not answer')), timeoutMs);
    onData((chunk) => {
      buf += chunk.toString('latin1');
      for (const frame of buf.split(/\r\n|\r|\n/)) {
        const r = parseScaleFrame(frame);
        if (r) {
          clearTimeout(timer);
          resolve(r);
          return;
        }
      }
      if (buf.length > 4096) buf = buf.slice(-512);
    });
  });
}

class TcpScale implements Scale {
  readonly kind = 'tcp';
  constructor(private readonly cfg: Extract<ScaleConfig, { type: 'tcp' }>) {}
  read(): Promise<WeightReading> {
    const socket = connect({ host: this.cfg.host, port: this.cfg.port });
    const reading = firstReading((cb) => socket.on('data', cb), 3_000);
    socket.once('connect', () => socket.write(this.cfg.request ?? 'W\r\n'));
    socket.once('error', () => undefined);
    return reading.finally(() => socket.destroy());
  }
}

class SerialScale implements Scale {
  readonly kind = 'serial';
  constructor(private readonly cfg: Extract<ScaleConfig, { type: 'serial' }>) {}
  async read(): Promise<WeightReading> {
    // Optional dependency: only tills with a serial scale install it.
    const mod = (await import('serialport' as string).catch(() => {
      throw new Error('Install the serialport package on this till to use a serial scale');
    })) as { SerialPort: new (o: { path: string; baudRate: number }) => { on(e: 'data', cb: (b: Buffer) => void): void; write(s: string): void; close(): void } };
    const port = new mod.SerialPort({ path: this.cfg.path, baudRate: this.cfg.baudRate ?? 9600 });
    const reading = firstReading((cb) => port.on('data', cb), 3_000);
    if (this.cfg.request) port.write(this.cfg.request);
    return reading.finally(() => port.close());
  }
}

export function createScale(cfg: ScaleConfig | undefined): Scale | null {
  switch (cfg?.type) {
    case 'fixed':
      return new FixedScale(cfg.grams);
    case 'tcp':
      return new TcpScale(cfg);
    case 'serial':
      return new SerialScale(cfg);
    default:
      return null;
  }
}
