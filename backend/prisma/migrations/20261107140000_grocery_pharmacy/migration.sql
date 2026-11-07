-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "plu" TEXT,
ADD COLUMN     "rxRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "soldByWeight" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tracksBatches" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "batches" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "prescriptionItemId" UUID;

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "batchId" UUID;

-- CreateTable
CREATE TABLE "Batch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "lotNo" TEXT NOT NULL,
    "expiresOn" DATE NOT NULL,
    "qtyMilli" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prescription" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "prescriber" TEXT NOT NULL,
    "prescriberRegNo" TEXT,
    "issuedOn" DATE NOT NULL,
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrescriptionItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "prescriptionId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "dispensedQtyMilli" INTEGER NOT NULL DEFAULT 0,
    "directions" TEXT,

    CONSTRAINT "PrescriptionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Batch_tenantId_storeId_expiresOn_idx" ON "Batch"("tenantId", "storeId", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_tenantId_id_key" ON "Batch"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_tenantId_storeId_productId_lotNo_key" ON "Batch"("tenantId", "storeId", "productId", "lotNo");

-- CreateIndex
CREATE INDEX "Prescription_tenantId_customerId_issuedOn_idx" ON "Prescription"("tenantId", "customerId", "issuedOn");

-- CreateIndex
CREATE UNIQUE INDEX "Prescription_tenantId_id_key" ON "Prescription"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PrescriptionItem_tenantId_id_key" ON "PrescriptionItem"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_plu_key" ON "Product"("tenantId", "plu");

-- AddForeignKey
ALTER TABLE "PrescriptionItem" ADD CONSTRAINT "PrescriptionItem_tenantId_prescriptionId_fkey" FOREIGN KEY ("tenantId", "prescriptionId") REFERENCES "Prescription"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Lots and prescriptions point at tenant rows only.
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_product_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id");
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_store_fkey" FOREIGN KEY ("tenantId", "storeId") REFERENCES "Store"("tenantId", "id");
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_customer_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id");
ALTER TABLE "PrescriptionItem" ADD CONSTRAINT "PrescriptionItem_product_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id");

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Batch', 'Prescription', 'PrescriptionItem']
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
