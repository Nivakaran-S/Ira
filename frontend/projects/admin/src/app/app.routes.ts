import type { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/guards';
import type { AdminRealm } from './core/realm';

export function routesFor(realm: AdminRealm): Routes {
  return [
    { path: 'login', canActivate: [guestGuard], title: 'Sign in', loadComponent: () => import('./auth/login').then((m) => m.Login) },
    { path: 'setup-password', title: 'Set password', loadComponent: () => import('./auth/setup-password').then((m) => m.SetupPassword) },
    realm === 'platform'
      ? { path: '', canActivate: [authGuard], loadChildren: () => import('./console/console.routes').then((m) => m.CONSOLE_ROUTES) }
      : { path: '', canActivate: [authGuard], loadChildren: () => import('./backoffice/backoffice.routes').then((m) => m.BACKOFFICE_ROUTES) },
    { path: '**', redirectTo: '' },
  ];
}
