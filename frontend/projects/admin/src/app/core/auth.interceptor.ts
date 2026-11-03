import { HttpErrorResponse, type HttpInterceptorFn, type HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { toApiError } from 'ui';
import { AuthStore, SKIP_AUTH } from './auth-store';

const withBearer = (req: HttpRequest<unknown>, token: string | null) =>
  token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

/**
 * Adds the bearer token, refreshes once on 401 and replays once. Every error leaves here as an ApiError.
 * A 401 that survives the replay (or happens while impersonating) ends the session and routes to sign-in.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.context.get(SKIP_AUTH)) return next(req).pipe(catchError((e) => throwError(() => toApiError(e))));
  const store = inject(AuthStore);
  const router = inject(Router);

  const signOut = (reason: string) => {
    const wasImpersonating = store.impersonating();
    store.clear();
    void router.navigateByUrl(`/login?reason=${wasImpersonating ? 'impersonation-ended' : reason}`);
  };

  return next(withBearer(req, store.accessToken())).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401 || store.impersonating() || !store.accessToken()) {
        if (err instanceof HttpErrorResponse && err.status === 401 && store.impersonating()) signOut('expired');
        return throwError(() => toApiError(err));
      }
      return from(store.refresh()).pipe(
        switchMap((ok) => {
          if (!ok) {
            signOut('expired');
            return throwError(() => toApiError(err));
          }
          return next(withBearer(req, store.accessToken())).pipe(
            catchError((again: unknown) => {
              if (again instanceof HttpErrorResponse && again.status === 401) signOut('expired');
              return throwError(() => toApiError(again));
            }),
          );
        }),
      );
    }),
  );
};
