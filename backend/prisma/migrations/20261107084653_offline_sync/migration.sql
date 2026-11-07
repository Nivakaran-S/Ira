-- One platform-wide, monotonic counter for down-sync cursors.
CREATE SEQUENCE sync_version AS BIGINT;
GRANT USAGE, SELECT ON SEQUENCE sync_version TO pos_app;

-- CreateEnum
CREATE TYPE "QuarantineStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "version" BIGINT NOT NULL DEFAULT nextval('sync_version');

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "offlineBlockEnd" INTEGER,
ADD COLUMN     "offlineBlockStart" INTEGER;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "version" BIGINT NOT NULL DEFAULT nextval('sync_version');

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "offline" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "catalogVersion" BIGINT,
ADD COLUMN     "offline" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TaxGroup" ADD COLUMN     "version" BIGINT NOT NULL DEFAULT nextval('sync_version');

-- CreateTable
CREATE TABLE "SyncCursor" (
    "deviceId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "lastHash" TEXT NOT NULL,
    "lastContactAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncCursor_pkey" PRIMARY KEY ("deviceId")
);

-- CreateTable
CREATE TABLE "SyncQuarantine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "registerId" UUID NOT NULL,
    "opId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "op" JSONB NOT NULL,
    "status" "QuarantineStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncQuarantine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncCursor_tenantId_deviceId_key" ON "SyncCursor"("tenantId", "deviceId");

-- CreateIndex
CREATE INDEX "SyncQuarantine_tenantId_status_createdAt_idx" ON "SyncQuarantine"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncQuarantine_tenantId_id_key" ON "SyncQuarantine"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SyncQuarantine_tenantId_deviceId_opId_key" ON "SyncQuarantine"("tenantId", "deviceId", "opId");

-- Every update takes a fresh version so tills can ask for "everything after N".
CREATE FUNCTION bump_sync_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."version" := nextval('sync_version');
  RETURN NEW;
END $$;

CREATE TRIGGER product_version BEFORE UPDATE ON "Product" FOR EACH ROW EXECUTE FUNCTION bump_sync_version();
CREATE TRIGGER category_version BEFORE UPDATE ON "Category" FOR EACH ROW EXECUTE FUNCTION bump_sync_version();
CREATE TRIGGER tax_group_version BEFORE UPDATE ON "TaxGroup" FOR EACH ROW EXECUTE FUNCTION bump_sync_version();

-- A group's resolved rates change when its membership or one of its rates changes.
CREATE FUNCTION bump_groups_for_rate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "TaxGroup" SET "name" = "name" WHERE id IN (SELECT "groupId" FROM "TaxGroupRate" WHERE "rateId" = NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER tax_rate_bumps_groups AFTER UPDATE ON "TaxRate" FOR EACH ROW EXECUTE FUNCTION bump_groups_for_rate();

CREATE FUNCTION bump_group_for_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "TaxGroup" SET "name" = "name" WHERE id = COALESCE(NEW."groupId", OLD."groupId");
  RETURN NULL;
END $$;
CREATE TRIGGER tax_group_rate_bumps_group AFTER INSERT OR UPDATE OR DELETE ON "TaxGroupRate" FOR EACH ROW EXECUTE FUNCTION bump_group_for_membership();

-- Tenant isolation.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['SyncCursor', 'SyncQuarantine']
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
