import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ApiError } from 'ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthStore, type LoginResult } from '../core/auth-store';
import { REALM } from '../core/realm';
import { Login } from './login';

function type(el: HTMLElement, selector: string, value: string) {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('Login', () => {
  let store: { login: ReturnType<typeof vi.fn>; verifyMfa: ReturnType<typeof vi.fn> };
  let navigate: ReturnType<typeof vi.fn>;

  async function render(result: LoginResult | Error) {
    store = {
      login: vi.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))),
      verifyMfa: vi.fn().mockResolvedValue(undefined),
    };
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthStore, useValue: store }, { provide: REALM, useValue: 'tenant' }],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true) as never;
    const fixture = TestBed.createComponent(Login);
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    type(el, '#email', 'owner@acme.lk');
    type(el, '#password', 'correct horse battery');
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    await fixture.whenStable();
    return { fixture, el };
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('goes home on ok', async () => {
    await render({ status: 'ok', accessToken: 't' });
    expect(store.login).toHaveBeenCalledWith('owner@acme.lk', 'correct horse battery');
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('asks for the code on mfa_required and verifies it', async () => {
    const { fixture, el } = await render({ status: 'mfa_required', mfaToken: 'm1' });
    expect(el.textContent).toContain('authenticator');
    expect(el.querySelector('ui-qr')).toBeNull();
    const otp = el.querySelector<HTMLInputElement>('ui-otp-input input')!;
    otp.value = '123456';
    otp.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.verifyMfa).toHaveBeenCalledWith('m1', '123456');
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('shows the QR and secret on mfa_setup_required', async () => {
    const { el } = await render({ status: 'mfa_setup_required', mfaToken: 'm2', otpauthUrl: 'otpauth://totp/x?secret=ABC', secret: 'ABCDEF' });
    expect(el.querySelector('ui-qr')).not.toBeNull();
    expect(el.textContent).toContain('ABCDEF');
  });

  it('shows a human error on failure', async () => {
    const { el } = await render(new ApiError(401, 'UNAUTHENTICATED', 'Invalid email or password', undefined, 'c'));
    expect(el.textContent).toContain('Invalid email or password');
    expect(navigate).not.toHaveBeenCalled();
  });
});
