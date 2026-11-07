#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PairingCode, PairingStore } from './auth.js';
import { createPrinter, type PrinterConfig } from './devices.js';
import { createScale, type ScaleConfig } from './scale.js';
import { createBridgeServer } from './server.js';
import { createTerminal, type TerminalConfig } from './terminal.js';

interface BridgeConfig {
  port?: number;
  printer?: PrinterConfig;
  scale?: ScaleConfig;
  terminal?: TerminalConfig;
  allowedOrigins?: string[];
}

const args = process.argv.slice(2);
const dev = args.includes('--dev');
const configPath = resolve(args.find((a) => a.startsWith('--config='))?.slice('--config='.length) ?? 'bridge.config.json');

let config: BridgeConfig = {};
try {
  config = JSON.parse(await readFile(configPath, 'utf8')) as BridgeConfig;
} catch {
  if (!dev) {
    console.error(`No config at ${configPath}. Copy bridge.config.example.json, or run with --dev.`);
    process.exit(1);
  }
}

const printer = createPrinter(config.printer ?? (dev ? { type: 'console' } : { type: 'none' }));
const scale = createScale(config.scale ?? (dev ? { type: 'fixed', grams: 1250 } : { type: 'none' }));
const terminal = createTerminal(config.terminal ?? (dev ? { type: 'sandbox' } : { type: 'none' }));
const pairing = new PairingStore(resolve(dirname(configPath), 'bridge.pairing.json'));
await pairing.load();
const pairingCode = new PairingCode((c) => console.log(`[bridge] pairing code (valid 10 min): ${c}`));
const port = config.port ?? 47800;

const server = createBridgeServer({
  printer, scale, terminal, pairing, pairingCode, allowedOrigins: config.allowedOrigins ?? [],
  log: (m) => console.log(`[bridge] ${m}`),
});

// Loopback only: the bridge is never reachable from the network.
server.listen(port, '127.0.0.1', () => {
  const paired = pairing.get();
  console.log(`[bridge] listening on http://127.0.0.1:${port} · printer: ${printer?.kind ?? 'none'} · scale: ${scale?.kind ?? 'none'} · terminal: ${terminal?.kind ?? 'none'}`);
  console.log(paired ? `[bridge] paired with device ${paired.deviceId}` : '[bridge] not paired yet');
  pairingCode.current();
  // Keep a valid code on screen: current() announces a new one whenever the old one expired.
  setInterval(() => pairingCode.current(), 30_000).unref();
});
