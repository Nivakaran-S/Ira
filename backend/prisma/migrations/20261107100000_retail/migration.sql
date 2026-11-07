-- CreateEnum
CREATE TYPE "LedgerReason" AS ENUM ('EARN', 'REDEEM', 'REVERSE', 'REFUND', 'ADJUST', 'RESTORE');

-- CreateEnum
CREATE TYPE "PromotionKind" AS ENUM ('PERCENT_OFF', 'AMOUNT_OFF', 'BUY_X_GET_Y', 'SPEND_THRESHOLD');

ALTER TYPE "PaymentMethod" ADD VALUE 'LOYALTY';
ALTER TYPE "PaymentMethod" ADD VALUE 'STORE_CREDIT';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "hasVariants" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parentId" UUID,
ADD COLUMN     "variantLabel" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "customerId" UUID,
ADD COLUMN     "loyaltyEarned" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promotions" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "Barcode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "productId" UUID NOT NULL,
    "version" BIGINT NOT NULL DEFAULT nextval('sync_version'),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Barcode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phoneEnc" TEXT,
    "phoneIdx" TEXT,
    "phoneLast4" TEXT,
    "emailEnc" TEXT,
    "emailIdx" TEXT,
    "notes" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyLedger" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "LedgerReason" NOT NULL,
    "saleId" UUID,
    "refundId" UUID,
    "note" TEXT,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreCreditLedger" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "LedgerReason" NOT NULL,
    "saleId" UUID,
    "refundId" UUID,
    "note" TEXT,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreCreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PromotionKind" NOT NULL,
    "productIds" UUID[],
    "categoryIds" UUID[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "percentBp" INTEGER,
    "amount" INTEGER,
    "buyQty" INTEGER,
    "getQty" INTEGER,
    "getPercentBp" INTEGER,
    "minSpend" INTEGER,
    "version" BIGINT NOT NULL DEFAULT nextval('sync_version'),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Barcode_tenantId_productId_idx" ON "Barcode"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Barcode_tenantId_code_key" ON "Barcode"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Customer_tenantId_phoneIdx_idx" ON "Customer"("tenantId", "phoneIdx");

-- CreateIndex
CREATE INDEX "Customer_tenantId_emailIdx_idx" ON "Customer"("tenantId", "emailIdx");

-- CreateIndex
CREATE INDEX "Customer_tenantId_name_idx" ON "Customer"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_id_key" ON "Customer"("tenantId", "id");

-- CreateIndex
CREATE INDEX "LoyaltyLedger_tenantId_customerId_createdAt_idx" ON "LoyaltyLedger"("tenantId", "customerId", "createdAt");

-- CreateIndex
CREATE INDEX "StoreCreditLedger_tenantId_customerId_createdAt_idx" ON "StoreCreditLedger"("tenantId", "customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_tenantId_id_key" ON "Promotion"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Product_tenantId_parentId_idx" ON "Product"("tenantId", "parentId");

-- CreateIndex
CREATE INDEX "Sale_tenantId_customerId_soldAt_idx" ON "Sale"("tenantId", "customerId", "soldAt");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_parentId_fkey" FOREIGN KEY ("tenantId", "parentId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Barcode" ADD CONSTRAINT "Barcode_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Ledgers and customers belong to the tenant: composite keys stop cross-tenant references.
ALTER TABLE "LoyaltyLedger" ADD CONSTRAINT "LoyaltyLedger_customer_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id");
ALTER TABLE "StoreCreditLedger" ADD CONSTRAINT "StoreCreditLedger_customer_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id");
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_customer_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id");

-- Down-sync versions.
CREATE TRIGGER barcode_version BEFORE UPDATE ON "Barcode" FOR EACH ROW EXECUTE FUNCTION bump_sync_version();
CREATE TRIGGER promotion_version BEFORE UPDATE ON "Promotion" FOR EACH ROW EXECUTE FUNCTION bump_sync_version();

-- Tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Barcode', 'Customer', 'LoyaltyLedger', 'StoreCreditLedger', 'Promotion']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK ("tenantId" = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- Balances are sums of append-only ledgers.
REVOKE UPDATE, DELETE, TRUNCATE ON "LoyaltyLedger", "StoreCreditLedger" FROM pos_app;
