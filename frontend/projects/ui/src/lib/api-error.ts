import { HttpErrorResponse } from '@angular/common/http';
import type { ErrorCode } from '@pos/shared';

export type ClientErrorCode = ErrorCode | 'NETWORK';

/** The API's error contract ({ code, message, details?, correlationId }) as a throwable. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode,
    message: string,
    readonly details: unknown,
    readonly correlationId: string | null,
  ) {
    super(message);
  }
}

function isContractBody(body: unknown): body is { code: ErrorCode; message: string; details?: unknown; correlationId?: string } {
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string' && typeof (body as { message?: unknown }).message === 'string';
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return new ApiError(0, 'NETWORK', 'Cannot reach the server', undefined, null);
    if (isContractBody(err.error)) {
      return new ApiError(err.status, err.error.code, err.error.message, err.error.details, err.error.correlationId ?? null);
    }
    return new ApiError(err.status, 'INTERNAL', 'Unexpected server response', undefined, err.headers?.get('x-correlation-id') ?? null);
  }
  return new ApiError(0, 'INTERNAL', 'Something went wrong', undefined, null);
}

const MESSAGES: Partial<Record<ClientErrorCode, string>> = {
  NETWORK: 'Cannot reach the server. Check the connection and try again.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
  ACCOUNT_LOCKED: 'This account is locked after too many failed attempts. Try again in 15 minutes.',
  TENANT_SUSPENDED: 'This business is suspended. Contact the platform administrator.',
  PLAN_LIMIT_REACHED: 'The plan limit for this item has been reached. Upgrade the plan or remove an existing one.',
  MODULE_DISABLED: 'This feature is not enabled for this business.',
  DEVICE_REVOKED: 'This device has been revoked.',
  DEVICE_SIGNATURE_INVALID: 'This device is not recognised.',
  STEP_UP_REQUIRED: 'A manager needs to approve this action.',
  TENANT_MISMATCH: 'This session belongs to a different business.',
};

/** A sentence safe to show a person. Server errors carry the correlation id for support. */
export function humanMessage(e: ApiError): string {
  if (e.code === 'FORBIDDEN') {
    const missing = (e.details as { missing?: unknown } | undefined)?.missing;
    if (Array.isArray(missing) && missing.length) return `You can only grant permissions you hold. Missing: ${missing.join(', ')}.`;
    return 'You do not have permission to do that.';
  }
  const base = MESSAGES[e.code] ?? e.message;
  return e.status >= 500 && e.correlationId ? `${base} (reference ${e.correlationId})` : base;
}

/** VALIDATION_FAILED details indexed by field path, for inline form errors. */
export function fieldErrors(e: ApiError): Record<string, string> {
  if (e.code !== 'VALIDATION_FAILED' || !Array.isArray(e.details)) return {};
  const out: Record<string, string> = {};
  for (const d of e.details as { path?: unknown; message?: unknown }[]) {
    if (typeof d.path === 'string' && typeof d.message === 'string' && !(d.path in out)) out[d.path] = d.message;
  }
  return out;
}
