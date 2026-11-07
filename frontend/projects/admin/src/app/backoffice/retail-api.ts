import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { PromotionDef } from '@pos/shared';
import { firstValueFrom } from 'rxjs';
import type { Product } from './commerce-api';

export interface CustomerRow {
  id: string;
  name: string;
  phoneLast4?: string | null;
  phone?: string | null;
  email?: string | null;
  createdAt: string;
  points?: number;
  credit?: number;
}
export interface LedgerRow {
  id: string;
  delta: number;
  reason: string;
  note: string | null;
  saleId: string | null;
  createdAt: string;
}
export interface CustomerDetail {
  customer: { id: string; name: string; phone: string | null; email: string | null; notes: string | null; createdAt: string };
  points: number;
  credit: number;
  sales: { id: string; receiptNo: string; due: number; status: string; soldAt: string; loyaltyEarned: number }[];
  loyaltyLedger: LedgerRow[];
  creditLedger: LedgerRow[];
}
export type PromotionInput = Omit<PromotionDef, 'id'>;
export type ProductWithCodes = Product & { barcodes?: { code: string }[]; hasVariants?: boolean; parentId?: string | null; variantLabel?: string | null };

/** Back-office calls for the retail modules. */
@Injectable({ providedIn: 'root' })
export class RetailApi {
  private readonly http = inject(HttpClient);

  customers(q = '') {
    return firstValueFrom(this.http.get<CustomerRow[]>(`/api/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`));
  }
  customer(id: string) {
    return firstValueFrom(this.http.get<CustomerDetail>(`/api/customers/${id}`));
  }
  createCustomer(input: { name: string; phone?: string; email?: string; notes?: string }) {
    return firstValueFrom(this.http.post<CustomerRow>('/api/customers', input));
  }
  adjust(id: string, kind: 'loyalty' | 'credit', delta: number, reason: string) {
    return firstValueFrom(this.http.post<{ points: number; credit: number }>(`/api/customers/${id}/${kind}/adjust`, { delta, reason }));
  }

  promotions() {
    return firstValueFrom(this.http.get<PromotionDef[]>('/api/promotions'));
  }
  savePromotion(input: PromotionInput, id?: string) {
    return firstValueFrom(id ? this.http.put<PromotionDef>(`/api/promotions/${id}`, input) : this.http.post<PromotionDef>('/api/promotions', input));
  }

  variants(productId: string) {
    return firstValueFrom(this.http.get<ProductWithCodes[]>(`/api/products/${productId}/variants`));
  }
  addVariants(productId: string, variants: { variantLabel: string; price?: number; sku?: string; barcode?: string }[]) {
    return firstValueFrom(this.http.post<ProductWithCodes[]>(`/api/products/${productId}/variants`, { variants }));
  }
  setBarcodes(productId: string, codes: string[]) {
    return firstValueFrom(this.http.put<{ codes: string[] }>(`/api/products/${productId}/barcodes`, { codes }));
  }
}
