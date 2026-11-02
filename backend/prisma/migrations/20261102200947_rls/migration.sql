-- Tenant isolation. Every tenant-scoped table is filtered by the transaction-local
-- setting app.tenant_id. With no setting, NULLIF(...) yields NULL and no row matches.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Store', 'Register', 'User', 'Role', 'UserRole', 'Device',
    'DeviceEnrollment', 'RefreshFamily', 'RefreshToken', 'AuditEvent'
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

-- Audit logs are append-only for the application role.
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditEvent", "PlatformAuditEvent" FROM pos_app;
