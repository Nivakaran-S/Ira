import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { ModuleOverride } from '@pos/shared';
import { firstValueFrom } from 'rxjs';

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED';
  country: string;
  currency: string;
  createdAt: string;
  businessType: { key: string; name: string };
  plan: { key: string };
}

export interface DomainView {
  id: string;
  hostname: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  txtName: string;
  txtValue: string;
}

export interface TenantDetail extends Omit<TenantSummary, 'businessType' | 'plan'> {
  timezone: string;
  businessTypeId: string;
  businessType: { id: string; key: string; name: string };
  plan: { id: string; key: string; name: string; maxStores: number; maxDevices: number; maxUsers: number };
  domains: Omit<DomainView, 'txtName' | 'txtValue'>[];
  moduleOverrides: ModuleOverride[];
}

export interface RoleTemplate {
  name: string;
  permissions: string[];
  requiresMfa: boolean;
}

export interface BusinessType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  modules: string[];
  roleTemplates: RoleTemplate[];
  defaultSettings: Record<string, unknown>;
}

export type BusinessTypeInput = Omit<BusinessType, 'id' | 'description'> & { description?: string };

export interface CreateTenantInput {
  name: string;
  slug: string;
  businessTypeId: string;
  ownerName: string;
  ownerEmail: string;
}

export interface CreatedTenant {
  tenant: TenantDetail;
  owner: { id: string; email: string };
  ownerSetupCode: string;
  host: string;
}

export interface TenantModules {
  base: string[];
  overrides: ModuleOverride[];
  resolved: string[];
}

export interface Impersonation {
  accessToken: string;
  expiresIn: number;
  sessionId: string;
  host: string;
  userId: string;
}

/** Typed calls to the super-admin API. Errors arrive as ApiError via the interceptor. */
@Injectable({ providedIn: 'root' })
export class ConsoleApi {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/platform';

  listTenants() {
    return firstValueFrom(this.http.get<TenantSummary[]>(`${this.base}/tenants`));
  }
  getTenant(id: string) {
    return firstValueFrom(this.http.get<TenantDetail>(`${this.base}/tenants/${id}`));
  }
  createTenant(input: CreateTenantInput) {
    return firstValueFrom(this.http.post<CreatedTenant>(`${this.base}/tenants`, input));
  }
  setStatus(id: string, status: 'ACTIVE' | 'SUSPENDED') {
    return firstValueFrom(this.http.patch<TenantDetail>(`${this.base}/tenants/${id}/status`, { status }));
  }
  changeBusinessType(id: string, businessTypeId: string) {
    return firstValueFrom(this.http.patch<TenantDetail>(`${this.base}/tenants/${id}/business-type`, { businessTypeId }));
  }
  deleteTenant(id: string) {
    return firstValueFrom(this.http.delete<void>(`${this.base}/tenants/${id}`));
  }

  getModules(id: string) {
    return firstValueFrom(this.http.get<TenantModules>(`${this.base}/tenants/${id}/modules`));
  }
  setModule(id: string, moduleKey: string, enabled: boolean) {
    return firstValueFrom(this.http.put<TenantModules>(`${this.base}/tenants/${id}/modules`, { moduleKey, enabled }));
  }
  clearModule(id: string, moduleKey: string) {
    return firstValueFrom(this.http.delete<TenantModules>(`${this.base}/tenants/${id}/modules/${moduleKey}`));
  }

  listDomains(id: string) {
    return firstValueFrom(this.http.get<DomainView[]>(`${this.base}/tenants/${id}/domains`));
  }
  addDomain(id: string, hostname: string) {
    return firstValueFrom(this.http.post<DomainView>(`${this.base}/tenants/${id}/domains`, { hostname }));
  }
  verifyDomain(id: string, domainId: string) {
    return firstValueFrom(this.http.post<DomainView & { verified: boolean }>(`${this.base}/tenants/${id}/domains/${domainId}/verify`, null));
  }
  removeDomain(id: string, domainId: string) {
    return firstValueFrom(this.http.delete<void>(`${this.base}/tenants/${id}/domains/${domainId}`));
  }

  impersonate(id: string, reason: string) {
    return firstValueFrom(this.http.post<Impersonation>(`${this.base}/tenants/${id}/impersonate`, { reason }));
  }
  endImpersonation(sessionId: string) {
    return firstValueFrom(this.http.post<void>(`${this.base}/impersonations/${sessionId}/end`, null));
  }

  listBusinessTypes() {
    return firstValueFrom(this.http.get<BusinessType[]>(`${this.base}/business-types`));
  }
  createBusinessType(input: BusinessTypeInput) {
    return firstValueFrom(this.http.post<BusinessType>(`${this.base}/business-types`, input));
  }
  updateBusinessType(id: string, input: BusinessTypeInput) {
    return firstValueFrom(this.http.put<BusinessType>(`${this.base}/business-types/${id}`, input));
  }
}
