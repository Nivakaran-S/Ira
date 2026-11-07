import { z } from 'zod';
import { minorAmount } from './catalog.js';

const positiveAmount = z.int().min(1).max(100_000_000_000);
const qtyMilli = z.int().min(1).max(100_000_000);

export const DiscountSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), bp: z.int().min(1).max(10_000) }),
  z.object({ kind: z.literal('amount'), amount: positiveAmount }),
]);

export const PAYMENT_METHODS = ['CASH', 'CARD', 'OTHER', 'LOYALTY', 'STORE_CREDIT'] as const;
export type PaymentMethodKey = (typeof PAYMENT_METHODS)[number];
/** What a refund can be paid back as. */
export const REFUND_METHODS = ['CASH', 'CARD', 'OTHER', 'STORE_CREDIT'] as const;

/** What an integrated card terminal reported for an approved charge or refund. */
export const CardResultSchema = z.object({
  scheme: z.string().trim().max(20),
  last4: z.string().regex(/^\d{4}$/),
  authCode: z.string().trim().max(20),
  /** The terminal's transaction id: refunds and reversals refer to it. */
  terminalRef: z.string().trim().min(1).max(64),
});
export type CardResult = z.infer<typeof CardResultSchema>;

export const PaymentInputSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  amount: positiveAmount,
  /** Cash handed over; change = tendered − amount. */
  tendered: minorAmount.optional(),
  /** Card terminal approval code or slip number. */
  reference: z.string().trim().max(64).optional(),
  /** Card payments taken on an integrated terminal. */
  card: CardResultSchema.optional(),
});

export const SaleLineInputSchema = z.object({
  productId: z.uuid(),
  qtyMilli,
  /** Price override (minor units). Needs price.override. */
  unitPrice: minorAmount.optional(),
  discount: DiscountSchema.optional(),
  note: z.string().trim().max(200).optional(),
  /** Modifiers module: options chosen for this item; their price deltas add to the unit price. */
  modifierIds: z.array(z.uuid()).max(20).optional(),
  /** Prescriptions module: the prescription item this line dispenses. */
  prescriptionItemId: z.uuid().optional(),
});

export const CreateSaleSchema = z.object({
  /** Client-generated UUIDv7: retries with the same id return the same sale. */
  id: z.uuid(),
  /** Needs the customers module. Required for loyalty and store-credit payments. */
  customerId: z.uuid().optional(),
  lines: z.array(SaleLineInputSchema).min(1).max(500),
  cartDiscount: DiscountSchema.optional(),
  payments: z.array(PaymentInputSchema).min(1).max(10),
  /** Gratuity on top of the amount due; payments cover due + tip. Not revenue, not taxed. */
  tip: minorAmount.default(0),
  /** What the till showed. Any difference from the server's calculation rejects the sale. */
  expectedTotal: minorAmount,
});

export const VoidSaleSchema = z.object({ reason: z.string().trim().min(3).max(200) });

export const CreateRefundSchema = z.object({
  id: z.uuid(),
  saleId: z.uuid(),
  lines: z.array(z.object({ saleLineId: z.uuid(), qtyMilli })).min(1).max(500),
  method: z.enum(REFUND_METHODS),
  reason: z.string().trim().min(3).max(200),
  /** Put the goods back on the shelf. */
  restock: z.boolean().default(true),
  /** Card refunds made on an integrated terminal. */
  card: CardResultSchema.optional(),
});

export const OpenShiftSchema = z.object({ openingFloat: minorAmount });
export const CloseShiftSchema = z.object({ countedCash: minorAmount, note: z.string().trim().max(500).optional() });
export const CashMovementSchema = z.object({
  type: z.enum(['PAY_IN', 'PAY_OUT', 'NO_SALE']),
  amount: minorAmount.default(0),
  reason: z.string().trim().min(3).max(200),
});

export const ReportRangeSchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  storeId: z.uuid().optional(),
});
