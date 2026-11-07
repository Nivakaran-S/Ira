import { inject } from '@angular/core';
import { type CanActivateFn, Router, type Routes } from '@angular/router';
import { PosSession } from './device/pos-session';

const enrolled: CanActivateFn = () => inject(PosSession).enrolled() || inject(Router).createUrlTree(['/enroll']);
const notEnrolled: CanActivateFn = () => !inject(PosSession).enrolled() || inject(Router).createUrlTree(['/pin']);
const cashier: CanActivateFn = () => inject(PosSession).signedIn() || inject(Router).createUrlTree(['/pin']);

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'till' },
  { path: 'enroll', title: 'Set up till', canActivate: [notEnrolled], loadComponent: () => import('./screens/enroll').then((m) => m.Enroll) },
  { path: 'pin', title: 'Sign in', canActivate: [enrolled], loadComponent: () => import('./screens/pin').then((m) => m.Pin) },
  {
    path: 'till',
    canActivate: [enrolled, cashier],
    loadComponent: () => import('./screens/till').then((m) => m.Till),
    children: [
      { path: '', title: 'Till', loadComponent: () => import('./screens/sell').then((m) => m.Sell) },
      { path: 'sales', title: 'Sales', loadComponent: () => import('./screens/sales-history').then((m) => m.SalesHistory) },
      { path: 'refund', title: 'Refund', loadComponent: () => import('./screens/refund').then((m) => m.Refund) },
      { path: 'shift', title: 'Shift', loadComponent: () => import('./screens/shift').then((m) => m.Shift) },
      { path: 'tables', title: 'Tables', loadComponent: () => import('./screens/floor').then((m) => m.FloorScreen) },
      { path: 'orders/:id', title: 'Order', loadComponent: () => import('./screens/order').then((m) => m.OrderScreen) },
    ],
  },
  { path: 'kitchen', title: 'Kitchen', canActivate: [enrolled, cashier], loadComponent: () => import('./screens/kitchen').then((m) => m.KitchenScreen) },
  { path: '**', redirectTo: 'till' },
];
