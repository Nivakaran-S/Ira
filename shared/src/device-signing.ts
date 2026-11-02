export const DEVICE_HEADERS = {
  id: 'x-device-id',
  ts: 'x-device-ts',
  nonce: 'x-device-nonce',
  sig: 'x-device-sig',
} as const;

/** The exact string a device signs. Path includes the query string, as sent. */
export function buildSigningPayload(method: string, path: string, bodySha256Hex: string, ts: string, nonce: string): string {
  return [method.toUpperCase(), path, bodySha256Hex, ts, nonce].join('\n');
}
