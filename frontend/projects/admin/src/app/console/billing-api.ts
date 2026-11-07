import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Plan {
  id: string;
  key: string;
  name: string;
  maxStores: number;
  maxDevices: number;
  maxUsers: number;
  maxProducts: number;
  priceMonthly: number;
  currency: string;
  graceDays: number;
  _count?: { tenants: number };
}
export type PlanInput = Omit<Plan, 'id' | '_count'>;
export interface Invoice {
  id: string;
  tenantId: string;
  number: string;
  planKey: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  currency: string;
  status: 'DUE' | 'PAID' | 'VOID';
  dueOn: string;
  paidAt: string | null;
  paidRef: string | null;
  tenant?: { name: string; slug: string };
}
export interface TenantBilling {
  plan: { key: string; name: string; priceMonthly: number; currency: string };
  limits: { stores: number; devices: number; users: number; products: number };
  usage: { stores: number; devices: number; users: number; products: number };
  invoices: Invoice[];
}

@Injectable({ providedIn: 'root' })
export class BillingApi {
  private readonly http = inject(HttpClient);

  plans() {
    return firstValueFrom(this.http.get<Plan[]>('/api/platform/plans'));
  }
  savePlan(input: PlanInput) {
    return firstValueFrom(this.http.post<Plan>('/api/platform/plans', input));
  }
  changePlan(tenantId: string, planKey: string) {
    return firstValueFrom(this.http.put(`/api/platform/tenants/${tenantId}/plan`, { planKey }));
  }
  tenantBilling(tenantId: string) {
    return firstValueFrom(this.http.get<TenantBilling>(`/api/platform/tenants/${tenantId}/billing`));
  }
  invoices(status?: string) {
    return firstValueFrom(this.http.get<Invoice[]>(`/api/platform/invoices${status ? `?status=${status}` : ''}`));
  }
  run() {
    return firstValueFrom(this.http.post<{ issued: number; suspended: number }>('/api/platform/billing/run', {}));
  }
  pay(id: string, reference: string) {
    return firstValueFrom(this.http.post<Invoice>(`/api/platform/invoices/${id}/pay`, { reference }));
  }
  void(id: string) {
    return firstValueFrom(this.http.post<Invoice>(`/api/platform/invoices/${id}/void`, {}));
  }
}
