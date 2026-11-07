import { Injectable } from '@nestjs/common';
import type { PrescriptionSchema } from '@pos/shared';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { TenantContext } from '../../common/request-context.js';
import type { Tx } from '../../infra/prisma.service.js';
import { TenantDb } from '../../infra/tenant-db.service.js';
import type { auditContext } from '../audit/audit-context.js';
import { AuditService } from '../audit/audit.service.js';

const day = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class PrescriptionsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  create(tenant: TenantContext, ctx: ReturnType<typeof auditContext>, userId: string, input: z.infer<typeof PrescriptionSchema>) {
    return this.tenantDb.run(tenant.id, async (tx) => {
      if (!(await tx.customer.findUnique({ where: { id: input.customerId } }))) throw AppError.notFound('Customer not found');
      const products = await tx.product.findMany({ where: { id: { in: input.items.map((i) => i.productId) } }, select: { id: true } });
      if (products.length !== new Set(input.items.map((i) => i.productId)).size) throw AppError.notFound('Product not found');
      const rx = await tx.prescription.create({
        data: {
          tenantId: tenant.id, customerId: input.customerId, prescriber: input.prescriber, prescriberRegNo: input.prescriberRegNo ?? null,
          issuedOn: new Date(`${input.issuedOn}T00:00:00Z`), notes: input.notes ?? null, createdById: userId,
          items: { create: input.items.map((i) => ({ productId: i.productId, qtyMilli: i.qtyMilli, directions: i.directions ?? null })) },
        },
        include: { items: true },
      });
      await this.audit.record(tx, tenant.id, {
        ...ctx, action: 'prescription.recorded', entityType: 'Prescription', entityId: rx.id,
        after: { customerId: input.customerId, prescriber: input.prescriber, items: input.items.length },
      });
      return this.view(rx);
    });
  }

  view(rx: { id: string; customerId: string; prescriber: string; prescriberRegNo: string | null; issuedOn: Date; notes: string | null; createdAt: Date; items: { id: string; productId: string; qtyMilli: number; dispensedQtyMilli: number; directions: string | null }[] }) {
    return { ...rx, issuedOn: day(rx.issuedOn) };
  }

  forCustomer(tenant: TenantContext, customerId: string) {
    return this.tenantDb.run(tenant.id, async (tx) =>
      (await tx.prescription.findMany({ where: { customerId }, include: { items: true }, orderBy: { issuedOn: 'desc' }, take: 50 })).map((r) => this.view(r)),
    );
  }

  /**
   * Checks a sale line can dispense from this prescription item: same customer and product, still
   * valid, enough left. Called inside the sale's transaction.
   */
  async checkDispense(tx: Tx, itemId: string, customerId: string | undefined | null, productId: string, qtyMilli: number, validDays: number) {
    const item = await tx.prescriptionItem.findUnique({ where: { id: itemId }, include: { prescription: true } });
    if (!item) throw AppError.notFound('Prescription item not found');
    if (!customerId || item.prescription.customerId !== customerId) throw new AppError('INVALID_STATE', 409, 'The prescription belongs to a different customer');
    if (item.productId !== productId) throw new AppError('INVALID_STATE', 409, 'The prescription is for a different medicine');
    const expires = new Date(item.prescription.issuedOn.getTime() + validDays * 86_400_000);
    if (expires < new Date()) throw new AppError('INVALID_STATE', 409, `The prescription is older than ${validDays} days`);
    if (item.dispensedQtyMilli + qtyMilli > item.qtyMilli) {
      throw new AppError('INVALID_STATE', 409, 'More than the prescription allows', { left: item.qtyMilli - item.dispensedQtyMilli });
    }
    return item;
  }

  async dispense(tx: Tx, itemId: string, qtyMilli: number, before: number) {
    const n = await tx.prescriptionItem.updateMany({ where: { id: itemId, dispensedQtyMilli: before }, data: { dispensedQtyMilli: { increment: qtyMilli } } });
    if (n.count !== 1) throw AppError.conflict('The prescription was dispensed meanwhile; try again');
  }
}
