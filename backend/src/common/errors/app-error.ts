import type { ErrorCode } from '@pos/shared';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  static unauthenticated(message = 'Authentication required') {
    return new AppError('UNAUTHENTICATED', 401, message);
  }
  static forbidden(message = 'Forbidden') {
    return new AppError('FORBIDDEN', 403, message);
  }
  static notFound(message = 'Not found') {
    return new AppError('NOT_FOUND', 404, message);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError('CONFLICT', 409, message, details);
  }
  static validation(details: unknown) {
    return new AppError('VALIDATION_FAILED', 400, 'Request validation failed', details);
  }
  static rateLimited() {
    return new AppError('RATE_LIMITED', 429, 'Too many attempts, try again later');
  }
}
