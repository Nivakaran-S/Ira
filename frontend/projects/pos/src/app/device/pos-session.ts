import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { type DevicePublicJwk, generateDeviceKeys } from './device-signer';
import { type DeviceRecord, DeviceStore } from './device-store';

/** Marks the refresh call so the interceptor neither retries it nor attaches a stale bearer. */
export const IS_REFRESH = new HttpContextToken<boolean>(() => false);

export interface PinUser {
  id: string;
  name: string;
}

/**
 * This till's identity (device key) and the signed-in cashier (access token, memory only).
 * Cashier sessions are device-bound: refresh is signed by the same device.
 */
@Injectable({ providedIn: 'root' })
export class PosSession {
  private readonly http = inject(HttpClient);
  private readonly store = inject(DeviceStore);

  readonly device = signal<DeviceRecord | null>(null);
  private readonly token = signal<string | null>(null);
  private inflight: Promise<boolean> | null = null;

  readonly accessToken = this.token.asReadonly();
  readonly enrolled = computed(() => this.device() !== null);
  readonly signedIn = computed(() => this.token() !== null);

  async loadDevice() {
    this.device.set(await this.store.get());
    return this.device();
  }

  setToken(token: string | null) {
    this.token.set(token);
  }

  async enroll(code: string, name: string) {
    const keys = await generateDeviceKeys();
    const r = await firstValueFrom(
      this.http.post<{ deviceId: string; registerId: string }>('/api/devices/enroll', { code: code.trim().toUpperCase(), name: name.trim(), publicKeyJwk: keys.publicKeyJwk satisfies DevicePublicJwk }),
    );
    const record: DeviceRecord = { deviceId: r.deviceId, registerId: r.registerId, name: name.trim(), privateKey: keys.privateKey, publicKey: keys.publicKey };
    await this.store.save(record);
    this.device.set(record);
  }

  /** Called when the API says this device is revoked or unknown. */
  async forgetDevice() {
    this.token.set(null);
    this.device.set(null);
    await this.store.clear();
  }

  whoami() {
    return firstValueFrom(this.http.get<{ id: string; registerId: string }>('/api/devices/whoami'));
  }

  pinPad() {
    return firstValueFrom(this.http.get<PinUser[]>('/api/users/pin-pad'));
  }

  async pinLogin(userId: string, pin: string) {
    const r = await firstValueFrom(this.http.post<{ accessToken: string }>('/api/auth/pin', { userId, pin }, { withCredentials: true }));
    this.token.set(r.accessToken);
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
    try {
      if (this.token()) await firstValueFrom(this.http.post<void>('/api/auth/logout', null, { withCredentials: true }));
    } finally {
      this.token.set(null);
    }
  }
}
