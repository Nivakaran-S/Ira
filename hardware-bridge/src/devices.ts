import { appendFile } from 'node:fs/promises';
import { connect } from 'node:net';

export type PrinterConfig =
  | { type: 'network'; host: string; port?: number; columns?: number }
  /** A device path or file: a Windows shared printer (\\\\localhost\\Receipt), COM port, or /dev/usb/lp0. */
  | { type: 'file'; path: string; columns?: number }
  /** Development: write a text rendering to stdout. */
  | { type: 'console'; columns?: number }
  | { type: 'none' };

export interface Printer {
  readonly columns: number;
  readonly kind: string;
  write(bytes: Buffer, preview: string): Promise<void>;
}

class NetworkPrinter implements Printer {
  readonly kind = 'network';
  constructor(
    private readonly host: string,
    private readonly port: number,
    readonly columns: number,
  ) {}

  write(bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port, timeout: 5_000 });
      socket.once('timeout', () => socket.destroy(new Error('Printer did not respond')));
      socket.once('error', reject);
      socket.once('connect', () => socket.end(bytes, () => resolve()));
    });
  }
}

class FilePrinter implements Printer {
  readonly kind = 'file';
  constructor(
    private readonly path: string,
    readonly columns: number,
  ) {}
  async write(bytes: Buffer) {
    await appendFile(this.path, bytes);
  }
}

class ConsolePrinter implements Printer {
  readonly kind = 'console';
  constructor(readonly columns: number) {}
  async write(_bytes: Buffer, preview: string) {
    process.stdout.write(`\n${'='.repeat(this.columns)}\n${preview}\n${'='.repeat(this.columns)}\n`);
  }
}

/** For tests: keeps every job. */
export class MemoryPrinter implements Printer {
  readonly kind = 'memory';
  readonly jobs: { bytes: Buffer; preview: string }[] = [];
  constructor(readonly columns = 42) {}
  async write(bytes: Buffer, preview: string) {
    this.jobs.push({ bytes, preview });
  }
}

export function createPrinter(cfg: PrinterConfig): Printer | null {
  switch (cfg.type) {
    case 'network':
      return new NetworkPrinter(cfg.host, cfg.port ?? 9100, cfg.columns ?? 48);
    case 'file':
      return new FilePrinter(cfg.path, cfg.columns ?? 48);
    case 'console':
      return new ConsolePrinter(cfg.columns ?? 42);
    default:
      return null;
  }
}
