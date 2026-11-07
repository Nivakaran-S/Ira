import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Discount, PaymentMethodKey, PromotionDef, ReceiptDoc, TaxRateDef, TenantSettings } from '@pos/shared';
import { firstValueFrom } from 'rxjs';

export interface CatalogProduct {
  id: string;
  name: string;
  sku: string | null;
  price: number;
  categoryId: string | null;
  trackStock: boolean;
  taxes: TaxRateDef[];
  hasVariants?: boolean;
  parentId?: string | null;
  variantLabel?: string | null;
}
export interface CatalogCategory {
  id: string;
  name: string;
  color: string | null;
}
export interface PosCatalog {
  currency: string;
  settings: TenantSettings;
  categories: CatalogCategory[];
  products: CatalogProduct[];
  modules?: string[];
  promotions?: PromotionDef[];
  /** Barcode → product id. */
  barcodes?: Record<string, string>;
}

export interface TillCustomer {
  id: string;
  name: string;
  phoneLast4: string | null;
  points: number;
  credit: number;
}

export interface ShiftReport {
  shift: {
    id: string; registerId: string; status: 'OPEN' | 'CLOSED'; openedAt: string; closedAt: string | null;
    openingFloat: number; countedCash: number | null; variance: number | null; note: string | null;
  };
  sales: { count: number; subtotal: number; discountTotal: number; taxTotal: number; total: number; rounding: number };
  voids: { count: number; total: number };
  refunds: { count: number; total: number };
  payments: { method: string; amount: number }[];
  refundsByMethod: { method: string; amount: number }[];
  cash: { openingFloat: number; sales: number; refunds: number; payIns: number; payOuts: number; expected: number };
  movements: { type: string; amount: number; reason: string; createdAt: string }[];
}

export interface SaleLine {
  id: string;
  position: number;
  productId: string;
  name: string;
  unitPrice: number;
  listPrice: number;
  qtyMilli: number;
  gross: number;
  discount: number;
  net: number;
  tax: number;
  total: number;
  refundedQtyMilli: number;
}
export interface Sale {
  id: string;
  receiptNo: string;
  status: 'COMPLETED' | 'VOIDED';
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  rounding: number;
  due: number;
  change: number;
  soldAt: string;
  shiftId: string;
  customerId: string | null;
  loyaltyEarned: number;
  lines: SaleLine[];
  payments: { id: string; method: PaymentMethodKey; amount: number; tendered: number | null; change: number; reference: string | null }[];
  refunds: { id: string; receiptNo: string; total: number; rounding: number; method: string; createdAt: string }[];
}
export interface SaleSummary {
  id: string;
  receiptNo: string;
  status: 'COMPLETED' | 'VOIDED';
  total: number;
  due: number;
  soldAt: string;
}
export interface Refund {
  id: string;
  receiptNo: string;
  total: number;
  rounding: number;
}

export interface SaleRequest {
  id: string;
  customerId?: string;
  lines: { productId: string; qtyMilli: number; unitPrice?: number; discount?: Discount; note?: string }[];
  cartDiscount?: Discount;
  payments: { method: PaymentMethodKey; amount: number; tendered?: number; reference?: string }[];
  expectedTotal: number;
}

/** Extra headers per call: manager approvals travel as x-step-up-token. */
export type CallHeaders = Record<string, string>;
const opts = (headers: CallHeaders = {}) => ({ headers: new HttpHeaders(headers) });

@Injectable({ providedIn: 'root' })
export class PosApi {
  private readonly http = inject(HttpClient);

  catalog() {
    return firstValueFrom(this.http.get<PosCatalog>('/api/pos/catalog'));
  }
  me() {
    return firstValueFrom(this.http.get<{ user: { id: string; name: string }; tenant: { name: string } }>('/api/me'));
  }
  approvers(action: string) {
    return firstValueFrom(this.http.get<{ id: string; name: string }[]>(`/api/pos/approvers?action=${encodeURIComponent(action)}`));
  }
  stepUp(approverUserId: string, pin: string, action: string) {
    return firstValueFrom(this.http.post<{ stepUpToken: string }>('/api/auth/step-up', { approverUserId, pin, action }));
  }

  shift() {
    return firstValueFrom(this.http.get<{ shift: ShiftReport | null }>('/api/pos/shift'));
  }
  openShift(openingFloat: number) {
    return firstValueFrom(this.http.post<ShiftReport>('/api/pos/shift/open', { openingFloat }));
  }
  closeShift(countedCash: number, note: string | undefined, h?: CallHeaders) {
    return firstValueFrom(this.http.post<ShiftReport>('/api/pos/shift/close', { countedCash, ...(note ? { note } : {}) }, opts(h)));
  }
  cash(type: 'PAY_IN' | 'PAY_OUT' | 'NO_SALE', amount: number, reason: string, h?: CallHeaders) {
    return firstValueFrom(this.http.post<unknown>('/api/pos/shift/cash', { type, amount, reason }, opts(h)));
  }

  sell(body: SaleRequest, h?: CallHeaders) {
    return firstValueFrom(this.http.post<Sale>('/api/pos/sales', body, opts(h)));
  }
  recent() {
    return firstValueFrom(this.http.get<SaleSummary[]>('/api/pos/sales/recent'));
  }
  sale(id: string) {
    return firstValueFrom(this.http.get<Sale>(`/api/pos/sales/${id}`));
  }
  lookup(receiptNo: string) {
    return firstValueFrom(this.http.get<Sale>(`/api/pos/sales/lookup?receiptNo=${encodeURIComponent(receiptNo)}`));
  }
  receipt(saleId: string, copy = false) {
    return firstValueFrom(this.http.get<ReceiptDoc>(`/api/pos/sales/${saleId}/receipt${copy ? '?copy=true' : ''}`));
  }
  void(saleId: string, reason: string, h?: CallHeaders) {
    return firstValueFrom(this.http.post<Sale>(`/api/pos/sales/${saleId}/void`, { reason }, opts(h)));
  }
  customers(q: string) {
    return firstValueFrom(this.http.get<TillCustomer[]>(`/api/pos/customers?q=${encodeURIComponent(q)}`));
  }
  createCustomer(input: { name: string; phone?: string }) {
    return firstValueFrom(this.http.post<TillCustomer>('/api/pos/customers', input));
  }
  refund(body: { id: string; saleId: string; lines: { saleLineId: string; qtyMilli: number }[]; method: PaymentMethodKey; reason: string; restock: boolean }, h?: CallHeaders) {
    return firstValueFrom(this.http.post<Refund>('/api/pos/refunds', body, opts(h)));
  }
  refundReceipt(id: string) {
    return firstValueFrom(this.http.get<ReceiptDoc>(`/api/pos/refunds/${id}/receipt`));
  }
}
