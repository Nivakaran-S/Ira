import type { Routes } from '@angular/router';
import { ConsoleLayout } from './layout';

export const CONSOLE_ROUTES: Routes = [
  {
    path: '',
    component: ConsoleLayout,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'tenants' },
      { path: 'tenants', title: 'Tenants', loadComponent: () => import('./tenants-list').then((m) => m.TenantsList) },
      { path: 'tenants/new', title: 'New tenant', loadComponent: () => import('./tenant-new').then((m) => m.TenantNew) },
      { path: 'tenants/:id', title: 'Tenant', loadComponent: () => import('./tenant-detail').then((m) => m.TenantDetail) },
      { path: 'business-types', title: 'Business types', loadComponent: () => import('./business-types').then((m) => m.BusinessTypes) },
    ],
  },
];
