export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'TENANT_SUSPENDED',
  'TENANT_MISMATCH',
  'MODULE_DISABLED',
  'PLAN_LIMIT_REACHED',
  'DEVICE_SIGNATURE_INVALID',
  'DEVICE_REVOKED',
  'STEP_UP_REQUIRED',
  'ACCOUNT_LOCKED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
  correlationId: string;
}
