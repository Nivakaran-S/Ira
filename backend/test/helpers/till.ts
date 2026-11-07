import type { NestExpressApplication } from '@nestjs/platform-express';
import request, { type Response } from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { signedHeaders, type TestDevice } from './device.js';
import { ownerDb } from './db.js';
import { bearer } from './http.js';

export type Pending = Promise<Response> & { expect(status: number): Promise<Response> };

/** A signed-in till: every call is device-signed and carries the cashier's token. */
export class TestTill {
  token: string | null = null;

  constructor(
    private readonly app: NestExpressApplication,
    readonly host: string,
    readonly device: TestDevice,
  ) {}

  /** Awaitable response with a supertest-like .expect(status) that reports the body on mismatch. */
  call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown, headers: Record<string, string> = {}): Pending {
    const p = this.send(method, path, body, headers);
    return Object.assign(p, {
      expect: async (status: number) => {
        const r = await p;
        if (r.status !== status) throw new Error(`${method} ${path}: expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
        return r;
      },
    });
  }

  private async send(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Response> {
    const http = request(this.app.getHttpServer());
    const signed = await signedHeaders(this.device, method, path, body);
    let r = http[method.toLowerCase() as 'get'](path).set('Host', this.host).set(signed).set(headers);
    if (this.token) r = r.set(bearer(this.token));
    return body === undefined ? r : r.send(body as object);
  }

  async login(userId: string, pin: string): Promise<this> {
    this.token = null;
    const res = await this.call('POST', '/api/auth/pin', { userId, pin });
    if (res.status !== 200) throw new Error(`PIN login failed: ${res.status} ${JSON.stringify(res.body)}`);
    this.token = res.body.accessToken;
    return this;
  }

  /** A manager approves `action` on this till for the signed-in cashier. */
  async stepUp(approverUserId: string, pin: string, action: string): Promise<string> {
    const res = await this.call('POST', '/api/auth/step-up', { approverUserId, pin, action });
    if (res.status !== 200) throw new Error(`step-up failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.stepUpToken;
  }

  openShift(openingFloat = 0) {
    return this.call('POST', '/api/pos/shift/open', { openingFloat });
  }

  sell(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return this.call('POST', '/api/pos/sales', { id: uuidv7(), ...body }, headers);
  }
}

/** A product with an optional tax group, straight into the DB. */
export async function createProduct(tenantId: string, input: { name?: string; price: number; taxGroupId?: string; trackStock?: boolean; sku?: string }) {
  return ownerDb().product.create({
    data: { tenantId, name: input.name ?? 'Item', price: input.price, taxGroupId: input.taxGroupId ?? null, trackStock: input.trackStock ?? true, sku: input.sku ?? null },
  });
}

/** VAT 18% + SSCL 2.5% as a group. */
export async function createSriLankaTaxes(tenantId: string) {
  const db = ownerDb();
  const vat = await db.taxRate.create({ data: { tenantId, name: 'VAT', rateBp: 1800 } });
  const sscl = await db.taxRate.create({ data: { tenantId, name: 'SSCL', rateBp: 250 } });
  const group = await db.taxGroup.create({ data: { tenantId, name: 'Standard' } });
  await db.taxGroupRate.createMany({
    data: [
      { tenantId, groupId: group.id, rateId: vat.id, position: 0 },
      { tenantId, groupId: group.id, rateId: sscl.id, position: 1 },
    ],
  });
  return { vat, sscl, group };
}

export async function setSettings(tenantId: string, settings: Record<string, unknown>) {
  await ownerDb().tenant.update({ where: { id: tenantId }, data: { settings: settings as object } });
}
