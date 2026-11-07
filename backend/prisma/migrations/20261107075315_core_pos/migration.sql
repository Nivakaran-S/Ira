-- CreateEnum
CREATE TYPE "StockReason" AS ENUM ('SALE', 'REFUND', 'VOID', 'ADJUSTMENT', 'RECEIVE', 'TRANSFER_IN', 'TRANSFER_OUT');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('PAY_IN', 'PAY_OUT', 'NO_SALE');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'OTHER');

-- AlterTable
ALTER TABLE "Register" ADD COLUMN     "receiptSeq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "compound" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxGroup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxGroupRate" (
    "tenantId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "rateId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "TaxGroupRate_pkey" PRIMARY KEY ("groupId","rateId")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "categoryId" UUID,
    "taxGroupId" UUID,
    "price" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trackStock" BOOLEAN NOT NULL DEFAULT true,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "qtyMilli" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("storeId","productId")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "deltaMilli" INTEGER NOT NULL,
    "reason" "StockReason" NOT NULL,
    "refType" TEXT,
    "refId" UUID,
    "note" TEXT,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" UUID NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloat" INTEGER NOT NULL,
    "closedById" UUID,
    "closedAt" TIMESTAMP(3),
    "expectedCash" INTEGER,
    "countedCash" INTEGER,
    "variance" INTEGER,
    "note" TEXT,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "approvedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "cashierId" UUID NOT NULL,
    "receiptNo" TEXT NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "pricesIncludeTax" BOOLEAN NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "discountTotal" INTEGER NOT NULL,
    "taxTotal" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "rounding" INTEGER NOT NULL DEFAULT 0,
    "due" INTEGER NOT NULL,
    "change" INTEGER NOT NULL DEFAULT 0,
    "taxes" JSONB NOT NULL,
    "cartDiscount" JSONB,
    "approvals" JSONB NOT NULL DEFAULT '[]',
    "soldAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "unitPrice" INTEGER NOT NULL,
    "listPrice" INTEGER NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "gross" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL,
    "discounts" JSONB NOT NULL,
    "net" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL,
    "taxes" JSONB NOT NULL,
    "total" INTEGER NOT NULL,
    "note" TEXT,
    "refundedQtyMilli" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "tendered" INTEGER,
    "change" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "saleId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "shiftId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "approvedById" UUID,
    "receiptNo" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reason" TEXT NOT NULL,
    "restock" BOOLEAN NOT NULL,
    "total" INTEGER NOT NULL,
    "taxTotal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "saleLineId" UUID NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "net" INTEGER NOT NULL,
    "tax" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,

    CONSTRAINT "RefundLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxRate_tenantId_id_key" ON "TaxRate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRate_tenantId_name_key" ON "TaxRate"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TaxGroup_tenantId_id_key" ON "TaxGroup"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TaxGroup_tenantId_name_key" ON "TaxGroup"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_tenantId_id_key" ON "Category"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_tenantId_name_key" ON "Category"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_id_key" ON "Product"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_sku_key" ON "Product"("tenantId", "sku");

-- CreateIndex
CREATE INDEX "StockMovement_tenantId_productId_createdAt_idx" ON "StockMovement"("tenantId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "Shift_tenantId_registerId_openedAt_idx" ON "Shift"("tenantId", "registerId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_tenantId_id_key" ON "Shift"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Sale_tenantId_soldAt_idx" ON "Sale"("tenantId", "soldAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_tenantId_id_key" ON "Sale"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_tenantId_receiptNo_key" ON "Sale"("tenantId", "receiptNo");

-- CreateIndex
CREATE UNIQUE INDEX "SaleLine_tenantId_id_key" ON "SaleLine"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_tenantId_id_key" ON "Refund"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_tenantId_receiptNo_key" ON "Refund"("tenantId", "receiptNo");

-- AddForeignKey
ALTER TABLE "TaxGroupRate" ADD CONSTRAINT "TaxGroupRate_tenantId_groupId_fkey" FOREIGN KEY ("tenantId", "groupId") REFERENCES "TaxGroup"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxGroupRate" ADD CONSTRAINT "TaxGroupRate_tenantId_rateId_fkey" FOREIGN KEY ("tenantId", "rateId") REFERENCES "TaxRate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "Category"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_taxGroupId_fkey" FOREIGN KEY ("tenantId", "taxGroupId") REFERENCES "TaxGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_tenantId_storeId_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_tenantId_registerId_fkey" FOREIGN KEY ("tenantId", "registerId") REFERENCES "Register"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_tenantId_shiftId_fkey" FOREIGN KEY ("tenantId", "shiftId") REFERENCES "Shift"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_tenantId_shiftId_fkey" FOREIGN KEY ("tenantId", "shiftId") REFERENCES "Shift"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleLine" ADD CONSTRAINT "SaleLine_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "Sale"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "Sale"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "Sale"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_tenantId_refundId_fkey" FOREIGN KEY ("tenantId", "refundId") REFERENCES "Refund"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_tenantId_saleLineId_fkey" FOREIGN KEY ("tenantId", "saleLineId") REFERENCES "SaleLine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tenant isolation for the Milestone 2 tables (same policy as the init RLS migration).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'TaxRate', 'TaxGroup', 'TaxGroupRate', 'Category', 'Product', 'StockLevel', 'StockMovement',
    'Shift', 'CashMovement', 'Sale', 'SaleLine', 'Payment', 'Refund', 'RefundLine'
  ]
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

-- At most one open shift per register.
CREATE UNIQUE INDEX "Shift_one_open_per_register" ON "Shift" ("tenantId", "registerId") WHERE status = 'OPEN';

-- Ledgers are append-only for the application role.
REVOKE UPDATE, DELETE, TRUNCATE ON "StockMovement", "CashMovement", "Payment", "RefundLine" FROM pos_app;
