import { HttpErrorResponse, type HttpEvent, type HttpHandlerFn, type HttpInterceptorFn, type HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, type Observable, switchMap, throwError } from 'rxjs';
import { ApiError, toApiError } from 'ui';
import { signRequest } from './device-signer';
import { IS_REFRESH, PosSession } from './pos-session';

/** Serialise the body ourselves so the bytes we hash are the bytes we send. */
function serialise(req: HttpRequest<unknown>): { req: HttpRequest<unknown>; text: string } {
  const b = req.body;
  if (b === null || b === undefined) return { req, text: '' };
  if (typeof b === 'string') return { req, text: b };
  const text = JSON.stringify(b);
  return { req: req.clone({ body: text, setHeaders: { 'Content-Type': 'application/json' } }), text };
}

async function prepare(req: HttpRequest<unknown>, session: PosSession): Promise<HttpRequest<unknown>> {
  const { req: r, text } = serialise(req);
  const headers: Record<string, string> = {};
  const device = session.device();
  if (device) Object.assign(headers, await signRequest(device.privateKey, device.deviceId, r.method, r.urlWithParams, text));
  const token = session.accessToken();
  if (token && !r.context.get(IS_REFRESH)) headers['Authorization'] = `Bearer ${token}`;
  return r.clone({ setHeaders: headers });
}

const send = (req: HttpRequest<unknown>, next: HttpHandlerFn, session: PosSession): Observable<HttpEvent<unknown>> =>
  from(prepare(req, session)).pipe(switchMap((signed) => next(signed)));

/**
 * Every POS API call is device-signed (fresh nonce per attempt) and carries the cashier token.
 * Revoked/unknown device → forget it and go back to enrolment. Expired cashier session → one
 * signed refresh and one replay, else back to the PIN pad.
 */
export const posInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  const session = inject(PosSession);
  const router = inject(Router);

  const onDeviceRejected = (err: ApiError) => {
    if (err.code === 'DEVICE_REVOKED' || (err.code === 'DEVICE_SIGNATURE_INVALID' && req.url === '/api/devices/whoami')) {
      void session.forgetDevice().then(() => router.navigateByUrl(`/enroll?reason=${err.code === 'DEVICE_REVOKED' ? 'revoked' : 'unknown'}`));
    }
  };

  return send(req, next, session).pipe(
    catchError((e: unknown) => {
      const err = toApiError(e);
      onDeviceRejected(err);
      const canRefresh = e instanceof HttpErrorResponse && e.status === 401 && err.code === 'UNAUTHENTICATED' && !req.context.get(IS_REFRESH) && session.accessToken() !== null;
      if (!canRefresh) return throwError(() => err);
      return from(session.refresh()).pipe(
        switchMap((ok) => {
          if (!ok) {
            void router.navigateByUrl('/pin?reason=expired');
            return throwError(() => err);
          }
          return send(req, next, session).pipe(catchError((again: unknown) => throwError(() => toApiError(again))));
        }),
      );
    }),
  );
};
