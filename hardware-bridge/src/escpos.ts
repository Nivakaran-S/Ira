import type { ReceiptDoc } from '@pos/shared';

const ESC = 0x1b;
const GS = 0x1d;

/** Thermal printers speak single-byte code pages; anything outside printable ASCII becomes '?'. */
function ascii(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '?');
}

/** Left text and right text on one line, the left side truncated if they would collide. */
export function twoCol(left: string, right: string, width: number): string {
  const r = ascii(right);
  const room = Math.max(0, width - r.length - 1);
  const l = ascii(left).slice(0, room);
  return l + ' '.repeat(width - l.length - r.length) + r;
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of ascii(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

class Writer {
  private readonly parts: number[] = [];
  bytes(...b: number[]) {
    this.parts.push(...b);
    return this;
  }
  text(s: string) {
    for (const ch of ascii(s)) this.parts.push(ch.charCodeAt(0));
    return this;
  }
  line(s = '') {
    return this.text(s).bytes(0x0a);
  }
  align(a: 'left' | 'center' | 'right') {
    return this.bytes(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
  }
  bold(on: boolean) {
    return this.bytes(ESC, 0x45, on ? 1 : 0);
  }
  /** Double height and width. */
  big(on: boolean) {
    return this.bytes(GS, 0x21, on ? 0x11 : 0x00);
  }
  build() {
    return Buffer.from(this.parts);
  }
}

export interface RenderOptions {
  columns: number;
  openDrawer?: boolean;
  cut?: boolean;
}

/** Drawer kick on pin 2: ESC p 0 t1 t2. */
export const DRAWER_KICK = Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]);

/** Renders a structured receipt to ESC/POS bytes. The bridge never prints raw bytes from the network. */
export function renderReceipt(doc: ReceiptDoc, opts: RenderOptions): Buffer {
  const w = opts.columns;
  const rule = '-'.repeat(w);
  const out = new Writer().bytes(ESC, 0x40); // initialise

  out.align('center');
  doc.header.forEach((h, i) => {
    if (i === 0) out.bold(true).big(true).line(h.slice(0, Math.floor(w / 2))).big(false).bold(false);
    else for (const l of wrap(h, w)) out.line(l);
  });
  out.line().bold(true).line(doc.title).bold(false);
  out.align('left');
  for (const m of doc.meta) out.line(twoCol(m.label, m.value, w));
  out.line(rule);

  for (const l of doc.lines) {
    for (const nl of wrap(l.name, w)) out.line(nl);
    out.line(twoCol(`  ${l.qty} x ${l.unitPrice}`, l.total, w));
    if (l.discount) out.line(twoCol('  Discount', l.discount, w));
    if (l.note) for (const nl of wrap(`  ${l.note}`, w)) out.line(nl);
  }
  out.line(rule);

  for (const t of doc.totals) {
    if (t.bold) out.bold(true).line(twoCol(t.label, t.value, w)).bold(false);
    else out.line(twoCol(t.label, t.value, w));
  }
  if (doc.taxes.length) {
    out.line();
    for (const t of doc.taxes) out.line(twoCol(t.label, t.value, w));
  }
  if (doc.payments.length) {
    out.line();
    for (const p of doc.payments) out.line(twoCol(p.label, p.value, w));
  }

  out.line().align('center');
  for (const f of doc.footer) for (const l of wrap(f, w)) out.line(l);

  if (doc.barcode && /^[\x20-\x7e]{1,40}$/.test(doc.barcode)) {
    // GS h (height) · GS H 2 (HRI below) · GS k 73 n {B data (CODE128, code set B)
    const data = Buffer.from(`{B${doc.barcode}`, 'ascii');
    out.line().bytes(GS, 0x68, 60, GS, 0x48, 2, GS, 0x6b, 73, data.length, ...data).line();
  }
  out.align('left').line().line().line();

  const body = out.build();
  const tail = opts.cut === false ? Buffer.alloc(0) : Buffer.from([GS, 0x56, 66, 0]); // feed and partial cut
  return Buffer.concat([body, tail, opts.openDrawer ? DRAWER_KICK : Buffer.alloc(0)]);
}

/** The same layout as plain text, for the dev console printer and previews. */
export function receiptText(doc: ReceiptDoc, columns: number): string {
  const lines: string[] = [];
  const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((columns - s.length) / 2))) + s;
  for (const h of doc.header) for (const l of wrap(h, columns)) lines.push(center(l));
  lines.push('', center(doc.title));
  for (const m of doc.meta) lines.push(twoCol(m.label, m.value, columns));
  lines.push('-'.repeat(columns));
  for (const l of doc.lines) {
    lines.push(...wrap(l.name, columns), twoCol(`  ${l.qty} x ${l.unitPrice}`, l.total, columns));
    if (l.discount) lines.push(twoCol('  Discount', l.discount, columns));
  }
  lines.push('-'.repeat(columns));
  for (const t of doc.totals) lines.push(twoCol(t.label, t.value, columns));
  for (const t of doc.taxes) lines.push(twoCol(t.label, t.value, columns));
  for (const p of doc.payments) lines.push(twoCol(p.label, p.value, columns));
  lines.push('');
  for (const f of doc.footer) for (const l of wrap(f, columns)) lines.push(center(l));
  if (doc.barcode) lines.push(center(`|| ${doc.barcode} ||`));
  return lines.join('\n');
}
