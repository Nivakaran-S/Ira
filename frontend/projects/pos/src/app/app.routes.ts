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
  { path: 'till', title: 'Till', canActivate: [enrolled, cashier], loadComponent: () => import('./screens/till').then((m) => m.Till) },
  { path: '**', redirectTo: 'till' },
];
