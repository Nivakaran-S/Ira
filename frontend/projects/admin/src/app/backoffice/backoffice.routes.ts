import type { Routes } from '@angular/router';
import { BackofficeLayout } from './layout';

export const BACKOFFICE_ROUTES: Routes = [
  {
    path: '',
    component: BackofficeLayout,
    children: [
      { path: '', pathMatch: 'full', title: 'Overview', loadComponent: () => import('./overview').then((m) => m.Overview) },
      { path: 'stores', title: 'Stores', loadComponent: () => import('./stores').then((m) => m.Stores) },
      { path: 'registers', title: 'Registers', loadComponent: () => import('./registers').then((m) => m.Registers) },
      { path: 'roles', title: 'Roles', loadComponent: () => import('./roles').then((m) => m.Roles) },
      { path: 'users', title: 'Users', loadComponent: () => import('./users').then((m) => m.Users) },
      { path: 'devices', title: 'Devices', loadComponent: () => import('./devices').then((m) => m.Devices) },
      { path: 'audit', title: 'Audit log', loadComponent: () => import('./audit').then((m) => m.Audit) },
    ],
  },
];
