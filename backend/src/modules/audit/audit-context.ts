import type { RequestWithContext } from '../../common/request-context.js';
import type { AuditEntry } from './audit.service.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  correlationId: string;
}

export function requestMeta(req: RequestWithContext): RequestMeta {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null, correlationId: req.correlationId };
}

/** Who did it, from where: spread into every audit entry written on behalf of a request. */
export function auditContext(
  req: RequestWithContext,
): Pick<AuditEntry, 'actorUserId' | 'impersonatorId' | 'deviceId' | 'ip' | 'userAgent' | 'correlationId'> {
  return {
    actorUserId: req.principal?.realm === 'tenant' ? req.principal.userId : null,
    impersonatorId: req.principal?.impersonatorId ?? null,
    deviceId: req.device?.id ?? req.principal?.deviceId ?? null,
    ...requestMeta(req),
  };
}
