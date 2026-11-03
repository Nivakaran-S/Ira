import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Me {
  user: { id: string; name: string; email: string | null };
  tenant: { id: string; name: string; slug: string };
  impersonatedBy: string | null;
  deviceId: string | null;
}
export interface Capabilities {
  modules: string[];
  permissions: string[];
  impersonatedBy: string | null;
}
export interface Store {
  id: string;
  name: string;
  code: string;
  createdAt: string;
}
export interface Register {
  id: string;
  storeId: string;
  name: string;
  code: string;
  createdAt: string;
}
export interface Role {
  id: string;
  name: string;
  permissions: string[];
  requiresMfa: boolean;
  isSystem: boolean;
  _count: { users: number };
}
export interface User {
  id: string;
  name: string;
  email: string | null;
  status: string;
  roles: { id: string; name: string }[];
  hasPin: boolean;
}
export interface Device {
  id: string;
  name: string;
  registerId: string;
  enrolledAt: string;
  enrolledById: string;
  revokedAt: string | null;
}
export interface Enrollment {
  code: string;
  expiresAt: string;
  registerId: string;
}
export interface AuditEvent {
  id: string;
  seq: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  impersonatorId: string | null;
  deviceId: string | null;
  ip: string | null;
  createdAt: string;
}
export type ChainResult = { ok: true; count: number } | { ok: false; brokenAtId: string };

@Injectable({ providedIn: 'root' })
export class BackofficeApi {
  private readonly http = inject(HttpClient);

  me() {
    return firstValueFrom(this.http.get<Me>('/api/me'));
  }
  capabilities() {
    return firstValueFrom(this.http.get<Capabilities>('/api/me/capabilities'));
  }

  stores() {
    return firstValueFrom(this.http.get<Store[]>('/api/stores'));
  }
  createStore(input: { name: string; code: string }) {
    return firstValueFrom(this.http.post<Store>('/api/stores', input));
  }
  registers() {
    return firstValueFrom(this.http.get<Register[]>('/api/registers'));
  }
  createRegister(input: { storeId: string; name: string; code: string }) {
    return firstValueFrom(this.http.post<Register>('/api/registers', input));
  }

  roles() {
    return firstValueFrom(this.http.get<Role[]>('/api/roles'));
  }
  createRole(input: { name: string; permissions: string[]; requiresMfa: boolean }) {
    return firstValueFrom(this.http.post<Role>('/api/roles', input));
  }

  users() {
    return firstValueFrom(this.http.get<User[]>('/api/users'));
  }
  createUser(input: { name: string; email?: string; roleIds: string[]; pin?: string }) {
    return firstValueFrom(this.http.post<{ user: User; setupCode: string | null }>('/api/users', input));
  }
  setPin(userId: string, pin: string) {
    return firstValueFrom(this.http.put<void>(`/api/users/${userId}/pin`, { pin }));
  }

  devices() {
    return firstValueFrom(this.http.get<Device[]>('/api/devices'));
  }
  createEnrollment(registerId: string) {
    return firstValueFrom(this.http.post<Enrollment>('/api/devices/enrollments', { registerId }));
  }
  revokeDevice(id: string) {
    return firstValueFrom(this.http.post<void>(`/api/devices/${id}/revoke`, null));
  }

  audit(limit = 100) {
    return firstValueFrom(this.http.get<AuditEvent[]>(`/api/audit?limit=${limit}`));
  }
  verifyAudit() {
    return firstValueFrom(this.http.get<ChainResult>('/api/audit/verify'));
  }
}
