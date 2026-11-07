import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { ReceiptDoc, TaxRateDef, TenantSettings } from '@pos/shared';
import { firstValueFrom } from 'rxjs';

export interface TaxRate {
  id: string;
  name: string;
  rateBp: number;
  compound: boolean;
  active: boolean;
}
export interface TaxGroup {
  id: string;
  name: string;
  rateIds: string[];
  rates: TaxRateDef[];
}
export interface Category {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
}
export interface Product {
  id: string;
  name: string;
  sku: string | null;
  categoryId: string | null;
  taxGroupId: string | null;
  price: number;
  active: boolean;
  trackStock: boolean;
  soldByWeight?: boolean;
  plu?: string | null;
  tracksBatches?: boolean;
  rxRequired?: boolean;
  costPrice?: number;
  reorderPoint?: number | null;
}
export type ProductInput = Omit<Product, 'id' | 'sku'> & { sku?: string };
export interface StockRow {
  id: string;
  name: string;
  sku: string | null;
  active: boolean;
  qtyMilli: number;
  updatedAt: string | null;
}
export interface SaleRow {
  id: string;
  receiptNo: string;
  status: 'COMPLETED' | 'VOIDED';
  total: number;
  due: number;
  soldAt: string;
  registerId: string;
  storeId: string;
}
export interface SaleDetail extends SaleRow {
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  rounding: number;
  change: number;
  cashierId: string;
  approvals: { action: string; approverId: string }[];
  lines: { id: string; name: string; qtyMilli: number; unitPrice: number; listPrice: number; discount: number; net: number; tax: number; total: number; refundedQtyMilli: number }[];
  payments: { id: string; method: string; amount: number; tendered: number | null; change: number; reference: string | null }[];
  refunds: { id: string; receiptNo: string; total: number; rounding: number; method: string; createdAt: string }[];
  voidReason: string | null;
}
export interface ShiftRow {
  id: string;
  registerId: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: string;
  closedAt: string | null;
  openingFloat: number;
  expectedCash: number | null;
  countedCash: number | null;
  variance: number | null;
  register: { code: string; name: string };
}
export interface ShiftReport {
  shift: { id: string; status: string; openedAt: string; closedAt: string | null; openingFloat: number; countedCash: number | null; variance: number | null; note: string | null };
  sales: { count: number; subtotal: number; discountTotal: number; taxTotal: number; total: number; rounding: number };
  voids: { count: number; total: number };
  refunds: { count: number; total: number };
  payments: { method: string; amount: number }[];
  cash: { openingFloat: number; sales: number; refunds: number; payIns: number; payOuts: number; expected: number };
  movements: { type: string; amount: number; reason: string; createdAt: string }[];
}
export interface SalesSummary {
  currency: string;
  range: { from: string; to: string; timezone: string };
  sales: { count: number; subtotal: number; discountTotal: number; taxTotal: number; total: number; tips?: number };
  voids: { count: number; total: number };
  refunds: { count: number; total: number };
  net: number;
  payments: { method: string; amount: number }[];
  byDay: { day: string; count: number; total: number }[];
  topProducts: { productId: string; name: string; qtyMilli: number; total: number }[];
  taxes: { name: string; rateBp: number; taxable: number; amount: number }[];
}
export type Settings = TenantSettings & { currency: string; country: string; timezone: string };

const params = (o: Record<string, string | undefined>) => {
  let p = new HttpParams();
  for (const [k, v] of Object.entries(o)) if (v) p = p.set(k, v);
  return { params: p };
};

/** Back-office calls for Milestone 2: catalog, stock, sales, shifts, reports, settings. */
@Injectable({ providedIn: 'root' })
export class CommerceApi {
  private readonly http = inject(HttpClient);

  taxRates() {
    return firstValueFrom(this.http.get<TaxRate[]>('/api/tax-rates'));
  }
  createTaxRate(input: Omit<TaxRate, 'id'>) {
    return firstValueFrom(this.http.post<TaxRate>('/api/tax-rates', input));
  }
  updateTaxRate(id: string, input: Partial<Omit<TaxRate, 'id'>>) {
    return firstValueFrom(this.http.patch<TaxRate>(`/api/tax-rates/${id}`, input));
  }
  taxGroups() {
    return firstValueFrom(this.http.get<TaxGroup[]>('/api/tax-groups'));
  }
  saveTaxGroup(input: { name: string; rateIds: string[] }, id?: string) {
    return firstValueFrom(id ? this.http.put<TaxGroup>(`/api/tax-groups/${id}`, input) : this.http.post<TaxGroup>('/api/tax-groups', input));
  }

  categories() {
    return firstValueFrom(this.http.get<Category[]>('/api/categories'));
  }
  createCategory(input: { name: string; color?: string }) {
    return firstValueFrom(this.http.post<Category>('/api/categories', input));
  }
  products(includeInactive = true) {
    return firstValueFrom(this.http.get<Product[]>('/api/products', params({ includeInactive: includeInactive ? 'true' : undefined })));
  }
  createProduct(input: ProductInput) {
    return firstValueFrom(this.http.post<Product>('/api/products', input));
  }
  updateProduct(id: string, input: Partial<ProductInput>) {
    return firstValueFrom(this.http.patch<Product>(`/api/products/${id}`, input));
  }

  stock(storeId: string) {
    return firstValueFrom(this.http.get<StockRow[]>('/api/stock', params({ storeId })));
  }
  adjustStock(input: { storeId: string; productId: string; deltaMilli: number; note: string }) {
    return firstValueFrom(this.http.post<{ qtyMilli: number }>('/api/stock/adjust', input));
  }

  sales(q: { from?: string; to?: string; receiptNo?: string; storeId?: string }) {
    return firstValueFrom(this.http.get<SaleRow[]>('/api/sales', params(q)));
  }
  sale(id: string) {
    return firstValueFrom(this.http.get<SaleDetail>(`/api/sales/${id}`));
  }
  receipt(id: string) {
    return firstValueFrom(this.http.get<ReceiptDoc>(`/api/sales/${id}/receipt`));
  }
  shifts() {
    return firstValueFrom(this.http.get<ShiftRow[]>('/api/shifts'));
  }
  shift(id: string) {
    return firstValueFrom(this.http.get<ShiftReport>(`/api/shifts/${id}`));
  }
  summary(from: string, to: string, storeId?: string) {
    return firstValueFrom(this.http.get<SalesSummary>('/api/reports/summary', params({ from, to, storeId })));
  }

  settings() {
    return firstValueFrom(this.http.get<Settings>('/api/settings'));
  }
  saveSettings(s: TenantSettings) {
    return firstValueFrom(this.http.put<TenantSettings>('/api/settings', s));
  }
}
