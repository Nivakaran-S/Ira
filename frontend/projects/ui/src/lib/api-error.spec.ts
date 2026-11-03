import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { ApiError, fieldErrors, humanMessage, toApiError } from './api-error';

const http = (status: number, error: unknown) => new HttpErrorResponse({ status, error });

describe('toApiError', () => {
  it('keeps the API error contract', () => {
    const e = toApiError(http(409, { code: 'CONFLICT', message: 'Already exists', correlationId: 'c-1' }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: 'CONFLICT', message: 'Already exists', correlationId: 'c-1' });
  });

  it('maps a network failure (status 0) to NETWORK', () => {
    expect(toApiError(http(0, new ProgressEvent('error'))).code).toBe('NETWORK');
  });

  it('maps a non-contract body to INTERNAL without leaking it', () => {
    const e = toApiError(http(502, '<html>Bad gateway</html>'));
    expect(e.code).toBe('INTERNAL');
    expect(e.message).not.toContain('html');
  });

  it('passes an ApiError through unchanged', () => {
    const original = new ApiError(403, 'FORBIDDEN', 'No', undefined, 'c');
    expect(toApiError(original)).toBe(original);
  });
});

describe('humanMessage', () => {
  it('appends the correlation id for server errors', () => {
    expect(humanMessage(new ApiError(500, 'INTERNAL', 'Internal error', undefined, 'abc-123'))).toContain('abc-123');
  });

  it('lists missing permissions on FORBIDDEN', () => {
    const msg = humanMessage(new ApiError(403, 'FORBIDDEN', 'Forbidden', { missing: ['sale.refund'] }, 'c'));
    expect(msg).toContain('sale.refund');
  });

  it('explains plan limits and lockouts', () => {
    expect(humanMessage(new ApiError(403, 'PLAN_LIMIT_REACHED', 'x', undefined, 'c'))).toMatch(/plan/i);
    expect(humanMessage(new ApiError(423, 'ACCOUNT_LOCKED', 'x', undefined, 'c'))).toMatch(/locked/i);
  });
});

describe('fieldErrors', () => {
  it('indexes validation details by path', () => {
    const e = new ApiError(400, 'VALIDATION_FAILED', 'Request validation failed', [
      { path: 'slug', message: 'Reserved slug' },
      { path: 'ownerEmail', message: 'Invalid email' },
    ], 'c');
    expect(fieldErrors(e)).toEqual({ slug: 'Reserved slug', ownerEmail: 'Invalid email' });
  });

  it('returns an empty map for other errors', () => {
    expect(fieldErrors(new ApiError(409, 'CONFLICT', 'x', undefined, 'c'))).toEqual({});
  });
});
