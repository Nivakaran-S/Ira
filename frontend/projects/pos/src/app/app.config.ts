import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { type ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { DeviceStore, IndexedDbDeviceStore } from './device/device-store';
import { posInterceptor } from './device/pos.interceptor';
import { PosSession } from './device/pos-session';

/** Load this till's identity, confirm the API still trusts it, and restore a cashier session if one is live. */
async function boot() {
  const session = inject(PosSession);
  if (!(await session.loadDevice())) return;
  try {
    await session.whoami();
  } catch {
    return; // revoked/unknown: the interceptor has already forgotten the device
  }
  await session.refresh();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: DeviceStore, useClass: IndexedDbDeviceStore },
    provideHttpClient(withInterceptors([posInterceptor])),
    provideRouter(routes, withComponentInputBinding()),
    provideAppInitializer(boot),
  ],
};
