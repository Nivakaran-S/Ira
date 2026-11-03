import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiError } from 'ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthStore, IMPERSONATION_KEY } from './auth-store';
import { authInterceptor } from './auth.interceptor';
import { detectRealm, REALM, type AdminRealm } from './realm';

function setup(realm: AdminRealm) {
  TestBed.configureTestingModule({
    providers: [
      { provide: REALM, useValue: realm },
      provideRouter([]),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  return { store: TestBed.inject(AuthStore), http: TestBed.inject(HttpClient), ctl: TestBed.inject(HttpTestingController) };
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

describe('detectRealm', () => {
  it('treats admin.* as the platform console and anything else as a tenant', () => {
    expect(detectRealm('admin.pos.localhost')).toBe('platform');
    expect(detectRealm('ADMIN.pos.lk')).toBe('platform');
    expect(detectRealm('acme.pos.localhost')).toBe('tenant');
    expect(detectRealm('shop.example.lk')).toBe('tenant');
  });
});

describe('AuthStore', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    sessionStorage.clear();
  });

  it('uses the platform auth base path on the admin host', async () => {
    const { store, ctl } = setup('platform');
    const p = store.refresh();
    const req = ctl.expectOne('/api/platform/auth/refresh');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ accessToken: 'p1' });
    expect(await p).toBe(true);
    expect(store.accessToken()).toBe('p1');
  });

  it('de-duplicates concurrent refreshes into one request', async () => {
    const { store, ctl } = setup('tenant');
    const a = store.refresh();
    const b = store.refresh();
    ctl.expectOne('/api/auth/refresh').flush({ accessToken: 't1' });
    expect(await Promise.all([a, b])).toEqual([true, true]);
  });

  it('a failed refresh clears the session', async () => {
    const { store, ctl } = setup('tenant');
    store.setToken('old');
    const p = store.refresh();
    ctl.expectOne('/api/auth/refresh').flush({ code: 'UNAUTHENTICATED', message: 'x', correlationId: 'c' }, { status: 401, statusText: 'x' });
    expect(await p).toBe(false);
    expect(store.accessToken()).toBeNull();
  });

  it('login stores the token on ok and returns MFA challenges untouched', async () => {
    const { store, ctl } = setup('tenant');
    const p1 = store.login('a@b.lk', 'pw');
    ctl.expectOne('/api/auth/login').flush({ status: 'mfa_required', mfaToken: 'm' });
    expect(await p1).toEqual({ status: 'mfa_required', mfaToken: 'm' });
    expect(store.accessToken()).toBeNull();
    const p2 = store.verifyMfa('m', '123456');
    ctl.expectOne('/api/auth/mfa/verify').flush({ status: 'ok', accessToken: 'tok' });
    await p2;
    expect(store.accessToken()).toBe('tok');
  });

  describe('impersonation', () => {
    beforeEach(() => history.replaceState(null, '', '/#imp=imp-token-1'));

    it('takes the token from the URL fragment, strips it, and keeps it tab-scoped', async () => {
      const { store } = setup('tenant');
      await store.init();
      expect(store.accessToken()).toBe('imp-token-1');
      expect(store.impersonating()).toBe(true);
      expect(location.hash).toBe('');
      expect(sessionStorage.getItem(IMPERSONATION_KEY)).toBe('imp-token-1');
    });

    it('is ignored on the platform host', async () => {
      const { store, ctl } = setup('platform');
      const p = store.init();
      ctl.expectOne('/api/platform/auth/refresh').flush({ accessToken: 'p' });
      await p;
      expect(store.impersonating()).toBe(false);
    });
  });
});

describe('authInterceptor', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('adds the bearer token', async () => {
    const { store, http, ctl } = setup('tenant');
    store.setToken('abc');
    const p = firstValueFrom(http.get('/api/me'));
    const req = ctl.expectOne('/api/me');
    expect(req.request.headers.get('authorization')).toBe('Bearer abc');
    req.flush({ ok: true });
    await p;
  });

  it('on 401 refreshes once and replays the request with the new token', async () => {
    const { store, http, ctl } = setup('tenant');
    store.setToken('expired');
    const p = firstValueFrom(http.get('/api/me'));
    ctl.expectOne('/api/me').flush({ code: 'UNAUTHENTICATED', message: 'x', correlationId: 'c' }, { status: 401, statusText: 'x' });
    await flushMicrotasks();
    ctl.expectOne('/api/auth/refresh').flush({ accessToken: 'fresh' });
    await flushMicrotasks();
    const replay = ctl.expectOne('/api/me');
    expect(replay.request.headers.get('authorization')).toBe('Bearer fresh');
    replay.flush({ me: 1 });
    expect(await p).toEqual({ me: 1 });
  });

  it('does not loop: a second 401 after the replay becomes an ApiError and routes to sign-in', async () => {
    const { store, http, ctl } = setup('tenant');
    const router = TestBed.inject(Router);
    let navigated = '';
    router.navigateByUrl = ((url: string) => {
      navigated = String(url);
      return Promise.resolve(true);
    }) as typeof router.navigateByUrl;
    store.setToken('expired');
    const p = firstValueFrom(http.get('/api/me')).catch((e: unknown) => e);
    const unauth = { code: 'UNAUTHENTICATED', message: 'x', correlationId: 'c' };
    ctl.expectOne('/api/me').flush(unauth, { status: 401, statusText: 'x' });
    await flushMicrotasks();
    ctl.expectOne('/api/auth/refresh').flush({ accessToken: 'fresh' });
    await flushMicrotasks();
    ctl.expectOne('/api/me').flush(unauth, { status: 401, statusText: 'x' });
    const err = await p;
    expect(err).toBeInstanceOf(ApiError);
    expect(navigated).toContain('/login');
  });

  it('maps other errors to ApiError without refreshing', async () => {
    const { http, ctl } = setup('tenant');
    const p = firstValueFrom(http.post('/api/stores', {})).catch((e: unknown) => e);
    ctl.expectOne('/api/stores').flush({ code: 'CONFLICT', message: 'Already exists', correlationId: 'c' }, { status: 409, statusText: 'x' });
    const err = (await p) as ApiError;
    expect(err.code).toBe('CONFLICT');
  });
});
