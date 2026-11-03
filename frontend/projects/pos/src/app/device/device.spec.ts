import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { buildSigningPayload, DEVICE_HEADERS } from '@pos/shared';
import { firstValueFrom } from 'rxjs';
import { ApiError } from 'ui';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DeviceStore, type DeviceRecord, MemoryDeviceStore } from './device-store';
import { base64UrlToBytes, generateDeviceKeys, sha256Hex, signRequest } from './device-signer';
import { posInterceptor } from './pos.interceptor';
import { PosSession } from './pos-session';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Signing is async (WebCrypto), so poll until the request reaches the backend. */
async function waitFor(ctl: HttpTestingController, match: string | ((r: import('@angular/common/http').HttpRequest<unknown>) => boolean)) {
  for (let i = 0; i < 200; i++) {
    const found = ctl.match(match as never);
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error('more than one request matched');
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('request never arrived: ' + String(match));
}

async function verify(publicKey: CryptoKey, payload: string, sig: string) {
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, base64UrlToBytes(sig), new TextEncoder().encode(payload));
}

describe('device signer', () => {
  let keys: Awaited<ReturnType<typeof generateDeviceKeys>>;
  beforeAll(async () => {
    keys = await generateDeviceKeys();
  });

  it('creates a non-extractable private key and a bare public JWK', async () => {
    expect(keys.privateKey.extractable).toBe(false);
    expect(Object.keys(keys.publicKeyJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(keys.publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    await expect(crypto.subtle.exportKey('pkcs8', keys.privateKey)).rejects.toThrow();
  });

  it('signs the shared payload format with a 64-byte P1363 signature that verifies', async () => {
    const h = await signRequest(keys.privateKey, 'dev-1', 'post', '/api/auth/pin?x=1', '{"a":1}');
    expect(base64UrlToBytes(h[DEVICE_HEADERS.sig]).length).toBe(64);
    const payload = buildSigningPayload('POST', '/api/auth/pin?x=1', await sha256Hex('{"a":1}'), h[DEVICE_HEADERS.ts], h[DEVICE_HEADERS.nonce]);
    expect(await verify(keys.publicKey, payload, h[DEVICE_HEADERS.sig])).toBe(true);
    expect(h[DEVICE_HEADERS.id]).toBe('dev-1');
    expect(h[DEVICE_HEADERS.ts]).toMatch(/^\d+$/);
    expect(h[DEVICE_HEADERS.nonce]).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });

  it('hashes an empty body as sha256 of nothing', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('posInterceptor', () => {
  async function setup() {
    const keys = await generateDeviceKeys();
    const store = new MemoryDeviceStore();
    const record: DeviceRecord = { deviceId: 'dev-1', registerId: 'reg-1', name: 'Till 1', privateKey: keys.privateKey, publicKey: keys.publicKey };
    await store.save(record);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: DeviceStore, useValue: store },
        provideHttpClient(withInterceptors([posInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    const session = TestBed.inject(PosSession);
    await session.loadDevice();
    return { keys, store, session, http: TestBed.inject(HttpClient), ctl: TestBed.inject(HttpTestingController) };
  }

  it('sends the exact bytes it hashed and signs the path with its query string', async () => {
    const { keys, http, ctl } = await setup();
    const p = firstValueFrom(http.post('/api/auth/pin?probe=1', { userId: 'u', pin: '1234' }));
    const req = await waitFor(ctl, '/api/auth/pin?probe=1');
    const body = req.request.body as string;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body)).toEqual({ userId: 'u', pin: '1234' });
    expect(req.request.headers.get('content-type')).toBe('application/json');
    const h = (k: string) => req.request.headers.get(k)!;
    const payload = buildSigningPayload('POST', '/api/auth/pin?probe=1', await sha256Hex(body), h(DEVICE_HEADERS.ts), h(DEVICE_HEADERS.nonce));
    expect(await verify(keys.publicKey, payload, h(DEVICE_HEADERS.sig))).toBe(true);
    req.flush({ ok: true });
    await p;
  });

  it('includes HttpParams in the signed path', async () => {
    const { keys, http, ctl } = await setup();
    const p = firstValueFrom(http.get('/api/users/pin-pad', { params: { a: 'b' } }));
    const req = await waitFor(ctl, (r) => r.urlWithParams === '/api/users/pin-pad?a=b');
    const h = (k: string) => req.request.headers.get(k)!;
    const payload = buildSigningPayload('GET', '/api/users/pin-pad?a=b', await sha256Hex(''), h(DEVICE_HEADERS.ts), h(DEVICE_HEADERS.nonce));
    expect(await verify(keys.publicKey, payload, h(DEVICE_HEADERS.sig))).toBe(true);
    req.flush([]);
    await p;
  });

  it('adds the bearer token once signed in', async () => {
    const { session, http, ctl } = await setup();
    session.setToken('tok');
    const p = firstValueFrom(http.get('/api/me'));
    const req = await waitFor(ctl, '/api/me');
    expect(req.request.headers.get('authorization')).toBe('Bearer tok');
    req.flush({});
    await p;
  });

  it('a revoked device is forgotten and the till returns to enrolment', async () => {
    const { store, http, ctl } = await setup();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const p = firstValueFrom(http.get('/api/users/pin-pad')).catch((e: unknown) => e);
    (await waitFor(ctl, '/api/users/pin-pad')).flush({ code: 'DEVICE_REVOKED', message: 'revoked', correlationId: 'c' }, { status: 401, statusText: 'x' });
    const err = (await p) as ApiError;
    await flush();
    expect(err.code).toBe('DEVICE_REVOKED');
    expect(await store.get()).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/enroll?reason=revoked');
  });

  it('on an expired session refreshes once (signed) and replays with a fresh signature', async () => {
    const { session, http, ctl } = await setup();
    session.setToken('old');
    const p = firstValueFrom(http.get('/api/me'));
    const first = await waitFor(ctl, '/api/me');
    const firstNonce = first.request.headers.get(DEVICE_HEADERS.nonce);
    first.flush({ code: 'UNAUTHENTICATED', message: 'x', correlationId: 'c' }, { status: 401, statusText: 'x' });
    const refresh = await waitFor(ctl, '/api/auth/refresh');
    expect(refresh.request.headers.get(DEVICE_HEADERS.sig)).toBeTruthy();
    expect(refresh.request.withCredentials).toBe(true);
    refresh.flush({ accessToken: 'new' });
    await flush();
    const replay = await waitFor(ctl, '/api/me');
    expect(replay.request.headers.get('authorization')).toBe('Bearer new');
    expect(replay.request.headers.get(DEVICE_HEADERS.nonce)).not.toBe(firstNonce);
    replay.flush({ me: 1 });
    expect(await p).toEqual({ me: 1 });
  });
});
