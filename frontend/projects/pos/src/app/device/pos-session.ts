import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { type DevicePublicJwk, generateDeviceKeys } from './device-signer';
import { HttpErrorResponse } from '@angular/common/http';
import { ApiError } from 'ui';
import { generateDataKey, LocalDb } from '../offline/local-db';
import { type OfflinePinResult, PinVerifiers } from '../offline/pin-verifier';
import { type DeviceRecord, DeviceStore } from './device-store';

/** Marks the refresh call so the interceptor neither retries it nor attaches a stale bearer. */
export const IS_REFRESH = new HttpContextToken<boolean>(() => false);

export interface PinUser {
  id: string;
  name: string;
}

/** Signed in on this till without the API: PIN checked against the local verifier. */
export interface OfflineUser {
  id: string;
  name: string;
}

export class OfflinePinError extends Error {
  constructor(readonly result: Exclude<OfflinePinResult, 'ok'>) {
    super(result);
  }
}

/**
 * This till's identity (device key) and the signed-in cashier (access token, memory only).
 * Cashier sessions are device-bound: refresh is signed by the same device.
 */
@Injectable({ providedIn: 'root' })
export class PosSession {
  private readonly http = inject(HttpClient);
  private readonly store = inject(DeviceStore);
  private readonly localDb = inject(LocalDb);
  private readonly verifiers = inject(PinVerifiers);

  readonly device = signal<DeviceRecord | null>(null);
  private readonly token = signal<string | null>(null);
  private inflight: Promise<boolean> | null = null;

  readonly offlineUser = signal<OfflineUser | null>(null);

  readonly accessToken = this.token.asReadonly();
  readonly enrolled = computed(() => this.device() !== null);
  readonly signedIn = computed(() => this.token() !== null || this.offlineUser() !== null);

  async loadDevice() {
    let record = await this.store.get();
    if (record && !record.dataKey) {
      record = { ...record, dataKey: await generateDataKey() };
      await this.store.save(record);
    }
    this.localDb.useKey(record?.dataKey ?? null);
    this.device.set(record);
    return record;
  }

  setToken(token: string | null) {
    this.token.set(token);
  }

  async enroll(code: string, name: string) {
    const keys = await generateDeviceKeys();
    const r = await firstValueFrom(
      this.http.post<{ deviceId: string; registerId: string }>('/api/devices/enroll', { code: code.trim().toUpperCase(), name: name.trim(), publicKeyJwk: keys.publicKeyJwk satisfies DevicePublicJwk }),
    );
    const record: DeviceRecord = {
      deviceId: r.deviceId, registerId: r.registerId, name: name.trim(), privateKey: keys.privateKey, publicKey: keys.publicKey, dataKey: await generateDataKey(),
    };
    this.localDb.useKey(record.dataKey!);
    await this.localDb.clear().catch(() => undefined);
    await this.store.save(record);
    this.device.set(record);
  }

  /** Called when the API says this device is revoked or unknown. */
  async forgetDevice() {
    this.token.set(null);
    this.offlineUser.set(null);
    this.device.set(null);
    await this.localDb.clear().catch(() => undefined);
    this.localDb.useKey(null);
    await this.store.clear();
  }

  whoami() {
    return firstValueFrom(this.http.get<{ id: string; registerId: string }>('/api/devices/whoami'));
  }

  pinPad() {
    return firstValueFrom(this.http.get<PinUser[]>('/api/users/pin-pad'));
  }

  /**
   * Online PIN sign-in; on success the till remembers a verifier so this person can sign in here
   * offline later. Without a connection, the verifier is checked instead.
   */
  async pinLogin(user: PinUser, pin: string): Promise<'online' | 'offline'> {
    try {
      const r = await firstValueFrom(this.http.post<{ accessToken: string }>('/api/auth/pin', { userId: user.id, pin }, { withCredentials: true }));
      this.offlineUser.set(null);
      this.token.set(r.accessToken);
      await this.verifiers.remember(user.id, pin).catch(() => undefined);
      return 'online';
    } catch (e) {
      const status = e instanceof HttpErrorResponse || e instanceof ApiError ? e.status : -1;
      if (![0, 502, 503, 504].includes(status)) throw e;
      return this.offlineLogin(user, pin);
    }
  }

  async offlineLogin(user: PinUser, pin: string): Promise<'offline'> {
    const result = await this.verifiers.verify(user.id, pin);
    if (result !== 'ok') throw new OfflinePinError(result);
    this.token.set(null);
    this.offlineUser.set({ id: user.id, name: user.name });
    return 'offline';
  }

  refresh(): Promise<boolean> {
    this.inflight ??= firstValueFrom(
      this.http.post<{ accessToken: string }>('/api/auth/refresh', null, { withCredentials: true, context: new HttpContext().set(IS_REFRESH, true) }),
    )
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

  async lock() {
    this.offlineUser.set(null);
    try {
      if (this.token()) await firstValueFrom(this.http.post<void>('/api/auth/logout', null, { withCredentials: true }));
    } finally {
      this.token.set(null);
    }
  }
}
