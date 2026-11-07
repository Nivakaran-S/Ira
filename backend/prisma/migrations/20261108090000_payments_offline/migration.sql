-- Integrated card terminals: what the terminal reported, on payments and refunds.
ALTER TABLE "Payment" ADD COLUMN "card" JSONB;
ALTER TABLE "Refund" ADD COLUMN "card" JSONB;

-- Offline voids and shift closes: the op that did it, so a resent op is recognised.
ALTER TABLE "Sale" ADD COLUMN "voidOpId" UUID;
ALTER TABLE "Shift" ADD COLUMN "closeOpId" UUID;

-- Customers reach the tills by down-sync; a balance change counts as a change to the customer.
ALTER TABLE "Customer" ADD COLUMN "version" BIGINT NOT NULL DEFAULT nextval('sync_version');
CREATE TRIGGER customer_version BEFORE UPDATE ON "Customer" FOR EACH ROW EXECUTE FUNCTION bump_sync_version();

CREATE FUNCTION bump_customer_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Customer" SET "version" = nextval('sync_version') WHERE "id" = NEW."customerId";
  RETURN NULL;
END $$;

CREATE TRIGGER loyalty_bumps_customer AFTER INSERT ON "LoyaltyLedger" FOR EACH ROW EXECUTE FUNCTION bump_customer_version();
CREATE TRIGGER credit_bumps_customer AFTER INSERT ON "StoreCreditLedger" FOR EACH ROW EXECUTE FUNCTION bump_customer_version();

-- Online invoice payments through a payment gateway (platform table, like Invoice).
CREATE TYPE "BillingPaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "BillingPayment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "BillingPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "providerRef" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingPayment_sessionId_key" ON "BillingPayment"("sessionId");
CREATE INDEX "BillingPayment_invoiceId_idx" ON "BillingPayment"("invoiceId");

ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
