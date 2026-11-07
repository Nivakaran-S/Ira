-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderLineStatus" AS ENUM ('NEW', 'SENT', 'PREPARING', 'READY', 'SERVED', 'VOID');

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "orderId" UUID,
ADD COLUMN     "tip" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "modifiers" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "orderLineId" UUID;

-- CreateTable
CREATE TABLE "ModifierGroup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "version" BIGINT NOT NULL DEFAULT nextval('sync_version'),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Modifier" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priceDelta" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Modifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductModifierGroup" (
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductModifierGroup_pkey" PRIMARY KEY ("productId","groupId")
);

-- CreateTable
CREATE TABLE "DiningTable" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "seats" INTEGER NOT NULL DEFAULT 2,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiningTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "tableId" UUID,
    "name" TEXT,
    "guests" INTEGER,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "qtyMilli" INTEGER NOT NULL,
    "paidQtyMilli" INTEGER NOT NULL DEFAULT 0,
    "unitPrice" INTEGER NOT NULL,
    "modifiers" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "course" INTEGER NOT NULL DEFAULT 1,
    "status" "OrderLineStatus" NOT NULL DEFAULT 'NEW',
    "sentAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModifierGroup_tenantId_id_key" ON "ModifierGroup"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModifierGroup_tenantId_name_key" ON "ModifierGroup"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Modifier_tenantId_id_key" ON "Modifier"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DiningTable_tenantId_id_key" ON "DiningTable"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DiningTable_tenantId_storeId_name_key" ON "DiningTable"("tenantId", "storeId", "name");

-- CreateIndex
CREATE INDEX "Order_tenantId_storeId_status_idx" ON "Order"("tenantId", "storeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_id_key" ON "Order"("tenantId", "id");

-- CreateIndex
CREATE INDEX "OrderLine_tenantId_status_sentAt_idx" ON "OrderLine"("tenantId", "status", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_tenantId_id_key" ON "OrderLine"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "Modifier" ADD CONSTRAINT "Modifier_tenantId_groupId_fkey" FOREIGN KEY ("tenantId", "groupId") REFERENCES "ModifierGroup"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_tenantId_groupId_fkey" FOREIGN KEY ("tenantId", "groupId") REFERENCES "ModifierGroup"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_tableId_fkey" FOREIGN KEY ("tenantId", "tableId") REFERENCES "DiningTable"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one open order per table.
CREATE UNIQUE INDEX "Order_one_open_per_table" ON "Order" ("tenantId", "tableId") WHERE status = 'OPEN' AND "tableId" IS NOT NULL;

-- Down-sync: modifier changes reach tills through their group; product links through the product.
CREATE TRIGGER modifier_group_version BEFORE UPDATE ON "ModifierGroup" FOR EACH ROW EXECUTE FUNCTION bump_sync_version();

CREATE FUNCTION bump_group_for_modifier() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ModifierGroup" SET "name" = "name" WHERE id = COALESCE(NEW."groupId", OLD."groupId");
  RETURN NULL;
END $$;
CREATE TRIGGER modifier_bumps_group AFTER INSERT OR UPDATE OR DELETE ON "Modifier" FOR EACH ROW EXECUTE FUNCTION bump_group_for_modifier();

CREATE FUNCTION bump_product_for_modifier_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "Product" SET "name" = "name" WHERE id = COALESCE(NEW."productId", OLD."productId");
  RETURN NULL;
END $$;
CREATE TRIGGER product_modifier_link_bumps_product AFTER INSERT OR UPDATE OR DELETE ON "ProductModifierGroup" FOR EACH ROW EXECUTE FUNCTION bump_product_for_modifier_link();

-- Sales point at their order.
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_order_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id");

-- Tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ModifierGroup', 'Modifier', 'ProductModifierGroup', 'DiningTable', 'Order', 'OrderLine']
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
