import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { REALM } from './realm';

/** Requests carrying this context skip the auth interceptor (refresh itself, sign-in calls). */
export const SKIP_AUTH = new HttpContextToken<boolean>(() => false);
export const IMPERSONATION_KEY = 'pos.impersonation';

export type LoginResult =
  | { status: 'ok'; accessToken: string }
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_setup_required'; mfaToken: string; otpauthUrl: string; secret: string };

const skip = () => ({ context: new HttpContext().set(SKIP_AUTH, true), withCredentials: true });

/**
 * Session state for the admin app. The access token lives in memory only; the refresh token is an
 * httpOnly cookie the browser sends to the auth base path. Impersonation tokens (no refresh) live in
 * sessionStorage so they die with the tab.
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly http = inject(HttpClient);
  readonly realm = inject(REALM);
  readonly base = this.realm === 'platform' ? '/api/platform/auth' : '/api/auth';

  private readonly token = signal<string | null>(null);
  private readonly impersonationToken = signal<string | null>(null);
  private inflight: Promise<boolean> | null = null;

  readonly accessToken = computed(() => this.impersonationToken() ?? this.token());
  readonly isAuthenticated = computed(() => this.accessToken() !== null);
  readonly impersonating = computed(() => this.impersonationToken() !== null);

  /** Bootstrap: take an impersonation token from the URL fragment, else try a silent refresh. */
  async init(): Promise<void> {
    if (this.realm === 'tenant') {
      const fromHash = /(?:^#|&)imp=([^&]+)/.exec(location.hash)?.[1];
      if (fromHash) {
        sessionStorage.setItem(IMPERSONATION_KEY, decodeURIComponent(fromHash));
        history.replaceState(history.state, '', location.pathname + location.search);
      }
      const stored = sessionStorage.getItem(IMPERSONATION_KEY);
      if (stored) {
        this.impersonationToken.set(stored);
        return;
      }
    }
    await this.refresh();
  }

  setToken(token: string | null) {
    this.token.set(token);
  }

  /** One refresh at a time: the API treats concurrent reuse of a refresh token as theft. */
  refresh(): Promise<boolean> {
    if (this.impersonating()) return Promise.resolve(false);
    this.inflight ??= firstValueFrom(this.http.post<{ accessToken: string }>(`${this.base}/refresh`, null, skip()))
      .then((r) => {
        this.token.set(r.accessToken);
        return true;
      })
      .catch(() => {
        this.token.set(null);
        return false;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const r = await firstValueFrom(this.http.post<LoginResult>(`${this.base}/login`, { email, password }, skip()));
    if (r.status === 'ok') this.token.set(r.accessToken);
    return r;
  }

  async verifyMfa(mfaToken: string, code: string): Promise<void> {
    const r = await firstValueFrom(this.http.post<{ accessToken: string }>(`${this.base}/mfa/verify`, { mfaToken, code }, skip()));
    this.token.set(r.accessToken);
  }

  async setupPassword(code: string, password: string): Promise<void> {
    await firstValueFrom(this.http.post<void>(`${this.base}/setup-password`, { code, password }, skip()));
  }

  async logout(): Promise<void> {
    if (this.impersonating()) {
      this.endImpersonation();
      return;
    }
    try {
      await firstValueFrom(this.http.post<void>(`${this.base}/logout`, null, { withCredentials: true }));
    } finally {
      this.token.set(null);
    }
  }

  endImpersonation() {
    sessionStorage.removeItem(IMPERSONATION_KEY);
    this.impersonationToken.set(null);
  }

  clear() {
    this.token.set(null);
    this.endImpersonation();
  }
}
