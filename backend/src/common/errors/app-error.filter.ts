import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ApiErrorBody, ErrorCode } from '@pos/shared';
import type { Response } from 'express';
import type { RequestWithContext } from '../request-context.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from './app-error.js';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

@Catch()
export class AppErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('AppErrorFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithContext>();
    const res = http.getResponse<Response>();
    const correlationId = req.correlationId ?? 'unknown';

    let status = 500;
    let body: Omit<ApiErrorBody, 'correlationId'> = { code: 'INTERNAL', message: 'Internal error' };

    if (exception instanceof AppError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message };
      if (exception.details !== undefined) body.details = exception.details;
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
      status = 409;
      body = { code: 'CONFLICT', message: 'Already exists' };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      body = { code: STATUS_CODES[status] ?? 'INTERNAL', message: status === 404 ? 'Not found' : exception.message };
    } else {
      this.logger.error({ correlationId, err: exception }, 'Unhandled error');
    }

    res.status(status).json({ ...body, correlationId });
  }
}
