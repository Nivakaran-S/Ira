import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { RequestWithContext } from './request-context.js';

const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

export function correlationMiddleware(req: RequestWithContext, res: Response, next: NextFunction) {
  const incoming = req.header('x-correlation-id');
  req.correlationId = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
}
