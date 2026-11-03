import { InjectionToken } from '@angular/core';

/** Which side of the admin app this host serves. The API's realm check is authoritative; this is UX. */
export type AdminRealm = 'platform' | 'tenant';

export function detectRealm(hostname: string): AdminRealm {
  return hostname.toLowerCase().startsWith('admin.') ? 'platform' : 'tenant';
}

export const REALM = new InjectionToken<AdminRealm>('REALM', {
  providedIn: 'root',
  factory: () => detectRealm(location.hostname),
});
