import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthStore } from './auth-store';

/** Signed-in only; otherwise to sign-in, remembering where they were going. */
export const authGuard: CanActivateFn = (_route, state) => {
  const store = inject(AuthStore);
  if (store.isAuthenticated()) return true;
  return inject(Router).createUrlTree(['/login'], { queryParams: state.url !== '/' ? { next: state.url } : {} });
};

/** Sign-in pages bounce signed-in users home. */
export const guestGuard: CanActivateFn = () => {
  const store = inject(AuthStore);
  return store.isAuthenticated() ? inject(Router).createUrlTree(['/']) : true;
};
