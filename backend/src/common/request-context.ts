import type { Request } from 'express';

export type HostRealm = 'tenant' | 'platform' | 'unknown';

export interface TenantContext {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  businessTypeId: string;
  planId: string;
}

export interface Principal {
  realm: 'tenant' | 'platform';
  userId: string;
  tenantId?: string;
  sessionId?: string;
  deviceId?: string;
  impersonatorId?: string;
}

export interface RequestWithContext extends Request {
  correlationId: string;
  hostRealm: HostRealm;
  tenant?: TenantContext;
  principal?: Principal;
  device?: { id: string; registerId: string };
  rawBody?: Buffer;
}
