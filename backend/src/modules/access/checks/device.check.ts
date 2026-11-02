import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { buildSigningPayload, DEVICE_HEADERS } from '@pos/shared';
import { sha256Hex } from '../../../common/crypto/hash.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { RequestWithContext } from '../../../common/request-context.js';
import { TenantDb } from '../../../infra/tenant-db.service.js';
import { type DevicePublicJwk, verifyDeviceSignature } from '../../../security/device-signature.js';
import { NonceStore } from '../../../security/nonce-store.js';
import type { AccessCheck } from '../access.guard.js';
import { DEVICE_KEY, routeMeta } from '../decorators.js';

export const MAX_CLOCK_SKEW_SEC = 120;
export const NONCE_TTL_SEC = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9-]{8,64}$/;
const invalid = (message = 'Invalid device signature') => new AppError('DEVICE_SIGNATURE_INVALID', 401, message);

@Injectable()
export class DeviceCheck implements AccessCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantDb: TenantDb,
    private readonly nonces: NonceStore,
  ) {}

  async check(ctx: ExecutionContext, req: RequestWithContext) {
    const id = req.header(DEVICE_HEADERS.id);
    const required = routeMeta<boolean>(this.reflector, DEVICE_KEY, ctx) === true;
    if (!required && !req.principal?.deviceId && !id) return;

    const ts = req.header(DEVICE_HEADERS.ts);
    const nonce = req.header(DEVICE_HEADERS.nonce);
    const sig = req.header(DEVICE_HEADERS.sig);
    if (!id || !ts || !nonce || !sig || !UUID.test(id) || !/^\d{1,12}$/.test(ts) || !NONCE.test(nonce)) throw invalid();
    if (req.principal?.deviceId && req.principal.deviceId !== id) throw invalid('Session is bound to a different device');
    if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_CLOCK_SKEW_SEC) throw invalid('Device clock skew too large');
    if (!req.tenant) throw invalid();

    const device = await this.tenantDb.run(req.tenant.id, (tx) => tx.device.findUnique({ where: { id } }));
    if (!device) throw invalid();
    if (device.revokedAt) throw new AppError('DEVICE_REVOKED', 401, 'This device has been revoked');

    const payload = buildSigningPayload(req.method, req.originalUrl, sha256Hex(req.rawBody ?? Buffer.alloc(0)), ts, nonce);
    if (!(await verifyDeviceSignature(device.publicKeyJwk as unknown as DevicePublicJwk, payload, sig))) throw invalid();
    // Claim the nonce only after the signature verifies, so forged requests cannot burn nonces.
    if (!(await this.nonces.claim(`${id}:${nonce}`, NONCE_TTL_SEC))) throw invalid('Replayed request');

    req.device = { id: device.id, registerId: device.registerId };
  }
}
