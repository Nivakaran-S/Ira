-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('SENT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DUE', 'PAID', 'VOID');

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'LKR',
ADD COLUMN     "graceDays" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "maxProducts" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "priceMonthly" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "costPrice" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reorderPoint" INTEGER;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "unitCost" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "suspendedReason" TEXT;

-- CreateTable
CREATE TABLE "TenantCounter" (
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TenantCounter_pkey" PRIMARY KEY ("tenantId","key")
);

-- CreateTable
CREATE TABLE "StorePrice" (
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "price" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorePrice_pkey" PRIMARY KEY ("storeId","productId")
);

-- CreateTable
CREATE TABLE "UserStore" (
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "storeId" UUID NOT NULL,

    CONSTRAINT "UserStore_pkey" PRIMARY KEY ("userId","storeId")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "expectedOn" DATE,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "poId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "receivedQtyMilli" INTEGER NOT NULL DEFAULT 0,
    "unitCost" INTEGER NOT NULL,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "fromStoreId" UUID NOT NULL,
    "toStoreId" UUID NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'SENT',
    "note" TEXT,
    "sentById" UUID NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" UUID,
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "transferId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "receivedQtyMilli" INTEGER,
    "batches" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "TransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DUE',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueOn" DATE NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paidRef" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StorePrice_tenantId_productId_idx" ON "StorePrice"("tenantId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_id_key" ON "Supplier"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_tenantId_name_key" ON "Supplier"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_id_key" ON "PurchaseOrder"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_number_key" ON "PurchaseOrder"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_tenantId_id_key" ON "PurchaseOrderLine"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_tenantId_id_key" ON "StockTransfer"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransfer_tenantId_number_key" ON "StockTransfer"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "TransferLine_tenantId_id_key" ON "TransferLine"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Invoice_status_dueOn_idx" ON "Invoice"("status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_periodStart_key" ON "Invoice"("tenantId", "periodStart");

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Supplier"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_tenantId_poId_fkey" FOREIGN KEY ("tenantId", "poId") REFERENCES "PurchaseOrder"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "StockTransfer"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-safe references the Prisma schema does not model.
ALTER TABLE "StorePrice" ADD CONSTRAINT "StorePrice_store_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", "id") ON DELETE CASCADE;
ALTER TABLE "StorePrice" ADD CONSTRAINT "StorePrice_product_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE CASCADE;
ALTER TABLE "UserStore" ADD CONSTRAINT "UserStore_user_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE CASCADE;
ALTER TABLE "UserStore" ADD CONSTRAINT "UserStore_store_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", "id") ON DELETE CASCADE;
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_store_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", "id");
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_product_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id");
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_from_fkey" FOREIGN KEY ("tenantId", "fromStoreId") REFERENCES "Store"("tenantId", "id");
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_to_fkey" FOREIGN KEY ("tenantId", "toStoreId") REFERENCES "Store"("tenantId", "id");
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_product_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id");

-- A store price change reaches tills through the product's down-sync version.
CREATE FUNCTION bump_product_for_store_price() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Product" SET "name" = "name" WHERE id = COALESCE(NEW."productId", OLD."productId");
  RETURN NULL;
END $$;
CREATE TRIGGER store_price_bumps_product AFTER INSERT OR UPDATE OR DELETE ON "StorePrice" FOR EACH ROW EXECUTE FUNCTION bump_product_for_store_price();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['TenantCounter', 'StorePrice', 'UserStore', 'Supplier', 'PurchaseOrder', 'PurchaseOrderLine', 'StockTransfer', 'TransferLine']
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
