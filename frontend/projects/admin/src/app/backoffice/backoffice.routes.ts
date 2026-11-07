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
      { path: 'catalog', title: 'Catalog', loadComponent: () => import('./catalog').then((m) => m.Catalog) },
      { path: 'taxes', title: 'Taxes', loadComponent: () => import('./taxes').then((m) => m.Taxes) },
      { path: 'customers', title: 'Customers', loadComponent: () => import('./customers').then((m) => m.Customers) },
      { path: 'customers/:id', title: 'Customer', loadComponent: () => import('./customer-detail').then((m) => m.CustomerDetail) },
      { path: 'promotions', title: 'Promotions', loadComponent: () => import('./promotions').then((m) => m.Promotions) },
      { path: 'stock', title: 'Stock', loadComponent: () => import('./stock').then((m) => m.Stock) },
      { path: 'sales', title: 'Sales', loadComponent: () => import('./sales').then((m) => m.Sales) },
      { path: 'shifts', title: 'Shifts', loadComponent: () => import('./shifts').then((m) => m.Shifts) },
      { path: 'reports', title: 'Reports', loadComponent: () => import('./reports').then((m) => m.Reports) },
      { path: 'settings', title: 'Settings', loadComponent: () => import('./settings').then((m) => m.Settings) },
      { path: 'offline-review', title: 'Offline review', loadComponent: () => import('./quarantine').then((m) => m.Quarantine) },
      { path: 'audit', title: 'Audit log', loadComponent: () => import('./audit').then((m) => m.Audit) },
    ],
  },
];
