import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { type ApplicationConfig, inject, isDevMode, provideAppInitializer, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideServiceWorker } from '@angular/service-worker';
import { PreloadAllModules, provideRouter, withComponentInputBinding, withPreloading } from '@angular/router';
import { routes } from './app.routes';
import { DeviceStore, IndexedDbDeviceStore } from './device/device-store';
import { posInterceptor } from './device/pos.interceptor';
import { PosSession } from './device/pos-session';
import { isOfflineError, SyncEngine } from './offline/sync-engine';

/**
 * Load this till's identity and its offline copy, confirm the API still trusts it, and restore a
 * cashier session if one is live. Without a connection the till starts from its offline copy.
 */
async function boot() {
  const session = inject(PosSession);
  const sync = inject(SyncEngine);
  if (!(await session.loadDevice())) return;
  await sync.init();
  try {
    await session.whoami();
  } catch (e) {
    if (isOfflineError(e)) sync.online.set(false);
    return; // offline, or revoked/unknown (the interceptor has already forgotten the device)
  }
  void sync.syncNow().catch(() => undefined);
  await session.refresh();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    { provide: DeviceStore, useClass: IndexedDbDeviceStore },
    provideHttpClient(withInterceptors([posInterceptor])),
    provideRouter(routes, withComponentInputBinding(), withPreloading(PreloadAllModules)),
    provideAppInitializer(boot),
    // The app shell is cached so a till can start with no network; API calls are never cached.
    provideServiceWorker('ngsw-worker.js', { enabled: !isDevMode(), registrationStrategy: 'registerWhenStable:30000' }),
  ],
};
