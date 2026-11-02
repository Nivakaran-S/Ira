# POS Platform — Design Spec

**Date:** 2026-11-02
**Status:** Approved in brainstorming, pending written-spec review
**Owner:** Niva

## 1. Purpose

A commercial, multi-tenant point-of-sale SaaS product sold to real businesses. A platform
super admin onboards each business (tenant), assigns it a business type and a web domain, and
controls which features it gets. Tills must keep selling when the internet drops.

### Success criteria

- A super admin can create a tenant, assign a business type and domain, and the tenant's staff
  can sign in on an enrolled device and complete a sale, without any code change or deploy.
- No tenant can read or modify another tenant's data, even with a bug in application code
  (enforced at the database by Row-Level Security, proven by an automated leakage test suite).
- A till that loses connectivity continues cash sales within tenant-defined limits, and every
  offline sale reaches the server exactly once, tamper-evident, when connectivity returns.
- Every sensitive action is attributable to a user, a device, and a time in an append-only audit log.

### Decisions made (from brainstorming)

| Topic | Decision |
|---|---|
| Use | Real product, multi-tenant SaaS |
| Verticals | All configurable by super admin; built in milestone order (§10) |
| "Domain" | Both business type and web domain, controlled by super admin |
| Connectivity | Offline and online capable |
| Client runtime | Angular PWA + small local hardware bridge |
| Tenant isolation | Shared PostgreSQL, `tenantId` on every row, enforced by RLS |
| Repo | Single repo, separate top-level folders, npm workspaces |
| Database | PostgreSQL 16 (Prisma is the ORM, not the database) |
| First market | Sri Lanka defaults (LKR, VAT/SSCL presets); country/currency/tax configurable per tenant |

## 2. Repository layout

```
POS/
├── backend/            NestJS API
│   ├── prisma/         schema.prisma, migrations, RLS SQL, seed
│   └── src/modules/    platform, identity, org, catalog, inventory, sales,
│                       payments, customers, reporting, sync, audit
├── frontend/           single Angular workspace
│   ├── projects/pos/       till PWA (cashier UI, offline)
│   ├── projects/admin/     super-admin console + tenant back-office
│   └── projects/ui/        shared component library
├── hardware-bridge/    local Node service: ESC/POS printing, cash drawer, scale
├── shared/             TypeScript types, Zod schemas, pricing/tax engine (used by backend and frontend)
├── infra/              docker-compose, Caddy, Postgres/Redis config
├── design/             mockups, assets
├── docs/               specs, plans, ADRs
└── package.json        npm workspaces root + orchestration scripts
```

## 3. Architecture

### Runtime components

- **API (`backend/`)**: NestJS modular monolith. Modules communicate via injected service
  interfaces and in-process domain events (`@nestjs/event-emitter`), never by reaching into
  each other's Prisma models. Any module can later be extracted into its own service.
- **PostgreSQL 16** via Prisma, with RLS policies on all tenant-owned tables.
- **Redis 7**: rate limiting, refresh-token family tracking and revocation lists, BullMQ job queues
  (receipt emails, report generation, domain verification, TLS checks).
- **POS PWA (`frontend/projects/pos`)**: Angular, service worker, IndexedDB via Dexie, outbox sync.
- **Admin app (`frontend/projects/admin`)**: Angular. One app, two realms: super-admin console
  (separate login route and token audience) and tenant back-office.
- **Hardware bridge (`hardware-bridge/`)**: Node service on each till, bound to `127.0.0.1` only.
  Accepts requests from the PWA signed with the device key. Drives ESC/POS printers (USB/network),
  cash drawer kick, serial scales.
- **Edge**: Caddy reverse proxy. Resolves tenant from `Host` (`{slug}.<platform-domain>` or a
  verified custom domain), terminates TLS, uses on-demand TLS with an `ask` endpoint on the API
  so certificates are only issued for verified domains.

### Request pipeline (every API call)

1. Caddy: TLS, forwards `Host`.
2. `TenantResolver` middleware: Host → tenant (cached in Redis). Unknown host → 404.
3. `AuthGuard`: verify access JWT (Ed25519, 5 min TTL, audience = `tenant` or `platform`).
4. `DeviceGuard`: verify the request's device signature (§4.2). Required for all POS routes.
5. `TenantStatusGuard`: tenant active, not suspended, within plan limits.
6. `ModuleGuard`: route's `@RequiresModule('x')` is enabled for the tenant.
7. `PermissionGuard`: route's `@RequiresPermission('sale.refund')` held by the user's roles;
   step-up check where required.
8. `TenantTransaction` interceptor: opens a Prisma interactive transaction and runs
   `SET LOCAL app.tenant_id = $1` (and `app.user_id`, `app.device_id`) before any query.
9. Handler → RLS-filtered queries → audit event written in the same transaction.

The token's tenant claim must match the Host-resolved tenant; mismatch → 403 and an audit event.

## 4. Zero-trust security model

Principle: no request is trusted because of its network origin, the device, or our own frontend.
Each call proves user, device, tenant, and permission, and is logged.

### 4.1 Identity

- Passwords hashed with Argon2id. MFA (TOTP or WebAuthn) mandatory for super admins, tenant
  owners, and managers.
- Cashiers sign in with a PIN, accepted only on an enrolled device (device = second factor).
  PIN attempts are rate-limited per device and per user; lockout after 5 failures.
- Access token: 5 min, Ed25519-signed JWT. Refresh token: rotating, httpOnly + Secure +
  SameSite=Strict cookie, 12 h idle / 7 day absolute. Reuse of a rotated refresh token revokes
  the whole token family.
- Super admins: separate realm, separate login route, token audience `platform`, optional IP
  allowlist. Impersonating a tenant requires a written reason, is limited to 30 minutes, is audited,
  and shows a visible banner in the tenant's UI.

### 4.2 Device trust

- On first run the till generates a non-extractable ECDSA P-256 keypair via WebCrypto, stored in IndexedDB.
- A manager enrolls the device with a one-time 8-character code (10 min TTL) from the back-office;
  the server stores the public key bound to tenant, store, and register.
- Every POS request carries headers `X-Device-Id`, `X-Device-Ts`, `X-Device-Nonce`,
  `X-Device-Sig` = signature over `method|path|sha256(body)|ts|nonce`. Server rejects if the
  timestamp is outside ±120 s or the nonce was seen within that window (Redis).
- Owners and super admins can revoke a device; revoked devices fail every request and every sync.

### 4.3 Authorization

- Granular permissions (`sale.create`, `sale.void`, `sale.refund`, `price.override`,
  `discount.apply`, `drawer.open`, `shift.close`, `stock.adjust`, `report.view`, …).
- Roles are permission sets. System roles are seeded per business type; tenants can create
  custom roles.
- Step-up: actions above tenant-configured thresholds (refund > X, discount > Y%, void, price
  override, no-sale drawer open) require a manager PIN on the same device. The approval is
  recorded on the audit event.
- RLS is the last line of defence beneath application checks; the app DB role is not the table
  owner and has `NOBYPASSRLS`. Migrations run under a separate owner role.

### 4.4 Offline security

- IndexedDB data is encrypted with AES-GCM using a non-extractable AES-GCM key generated by
  WebCrypto at enrollment and stored as a `CryptoKey` in IndexedDB (separate from the signing key).
  This protects against copying the database files off the machine, not against code running in
  the page itself. Local data is wiped when the server reports the device revoked.
- Each offline sale includes `prevHash` (hash of the previous offline sale on that register) and
  is signed by the device key. On sync the server verifies the chain and signatures; gaps or bad
  signatures quarantine the batch and alert the owner.
- Tenant-configured offline limits: max offline duration (default 24 h), max single refund offline
  (default 0 = refunds disabled offline), no store-credit or loyalty redemption offline, cash only
  unless an offline-capable card terminal is configured.

### 4.5 Data protection

- TLS everywhere. HSTS on platform domains.
- Customer PII (phone, email, address) encrypted at field level (AES-GCM, key from env/KMS),
  with a blind-index HMAC column for lookup.
- Secrets only in environment/KMS; `.env` files git-ignored; `.env.example` committed.
- Append-only audit log: each `AuditEvent` stores actor, device, tenant, action, entity, before/after
  JSON, IP, user agent, and `hash = sha256(prevHash + payload)`. The app role has INSERT and
  SELECT only on this table.
- Security headers via Helmet; strict CSP on both Angular apps; CORS restricted to tenant hosts.

## 5. Configurability (super-admin layer)

- **Tenants**: create, suspend, reactivate, delete (soft delete with 30-day purge); plan and
  limits (stores, registers/devices, users, products).
- **Domains**: every tenant gets `{slug}.<platform-domain>`. Custom domains are added by super
  admin, verified by a DNS TXT record (`_pos-verify.<domain>`), then TLS is issued on demand.
  Verification is re-checked daily by a job.
- **Business types**: named templates (e.g. Café, Pharmacy, Boutique, Grocery) bundling enabled
  modules, default settings, seeded roles, receipt template, and tax preset. Created and edited
  in the super-admin UI, no code changes. Changing a tenant's business type re-applies modules
  but never deletes data.
- **Modules**: registry with dependencies. Initial set: `core` (always on), `variants`, `barcodes`,
  `promotions`, `loyalty`, `customers`, `tables`, `modifiers`, `kitchen-display`, `split-bill`,
  `weighed-items`, `batch-expiry`, `prescriptions`, `multi-store`, `purchasing`.
  Dependencies are enforced on enable (e.g. `kitchen-display` → `modifiers`; `split-bill` → `tables`).
  Super admin can override modules per tenant on top of the business-type template.
- **Custom fields**: definitions per entity (product, customer, sale) of type text, number, date,
  boolean, or select; values stored in a validated JSONB `customFields` column. Defined by super
  admin (on the business type) or tenant owner (on the tenant).
- **Localisation**: country, currency, timezone, tax rules (inclusive/exclusive, multiple stacked
  rates such as VAT + SSCL, per-category rates), receipt language, receipt numbering format.
  Country presets; Sri Lanka is the first preset.
- **Enforcement**: `ModuleGuard` on the backend is authoritative. The frontend hides disabled
  modules for UX only, reading the tenant's module set from `/me/capabilities`.

## 6. Data model

All tenant-owned tables carry `tenantId` and have RLS policies
`USING (tenant_id = current_setting('app.tenant_id')::uuid)` with matching `WITH CHECK`.
Primary keys are UUIDv7 (time-ordered, generatable offline).

- **Platform** (not tenant-scoped, platform realm only): `Tenant`, `Domain`, `Plan`,
  `BusinessType`, `BusinessTypeModule`, `Module`, `TenantModule`, `SuperAdmin`, `PlatformAuditEvent`.
- **Identity**: `User`, `Role`, `Permission`, `RolePermission`, `UserRole`, `Device`,
  `DeviceEnrollment`, `RefreshTokenFamily`, `AuditEvent`.
- **Org**: `Store`, `Register`, `Shift` (opened by, opening float, expected vs counted cash, variance, closed by).
- **Catalog**: `Product`, `Variant`, `Category`, `Barcode`, `PriceList`, `Price`, `TaxRate`,
  `TaxGroup`, `ModifierGroup`, `Modifier`, `CustomFieldDefinition`.
- **Inventory**: `StockLevel` (store × variant, denormalised), `StockMovement` (append-only:
  sale, refund, adjustment, transfer-in/out, receive, with reason), `Batch` (lot, expiry).
- **Sales**: `Sale` (status: open, completed, voided), `SaleLine`, `SaleLineModifier`,
  `Payment` (method, amount, reference), `Refund`, `RefundLine`, `Discount`, `Receipt`.
- **Customers**: `Customer`, `LoyaltyLedger` (append-only), `StoreCreditLedger` (append-only).
- **Sync**: `SyncCursor` (per device), `SyncBatch` (received offline batches, status, verification result).

### Money and tax rules

- All amounts are integers in minor units (e.g. cents). No floats anywhere in money paths.
- The pricing/tax engine lives in `shared/` as a pure function used by both the till (offline) and
  the server. The server always recomputes totals; a mismatch beyond 0 minor units quarantines the sale.
- Rounding: per line, half-up, to the currency's minor unit; cash rounding configurable per tenant.
- Completed sales are immutable. Corrections are refunds or voids (voids only within the open shift).

## 7. Offline sync

- **Down-sync** (server → till): catalog, prices, taxes, modules, settings, the register's users
  and their permissions, customers (if `customers` enabled). Delta-based on a per-table monotonic
  `version` column; the till stores its cursor. Full resync on schema version change.
- **Up-sync** (till → server): sales, refunds, shift events, and stock adjustments written to an
  IndexedDB outbox. Client-generated UUIDv7 ids; receipt number `{registerCode}-{sequence}`
  allocated locally, so there are no collisions. Pushes are idempotent on id; retries are safe.
- **Conflict policy**:
  - A completed sale is a fact. The server accepts it even if stock goes negative; negative stock is
    flagged to managers.
  - Prices, taxes, and permissions are evaluated as of the sale's timestamp, using the versions the
    till had, provided the sale is within the tenant's offline window.
  - Sales outside the offline window, with broken hash chains, bad signatures, or total mismatches
    go to quarantine for manager review. They are never silently accepted or silently dropped.
- **Connectivity UX**: a persistent online/offline indicator, the outbox count, and the time of the
  last successful sync. Hard stop when the offline limit is reached.

## 8. Hardware bridge

- Runs as a background service on the till (Windows service / systemd), listening on
  `127.0.0.1:47800` only.
- Requests from the PWA are signed with the device key; the bridge is paired once with the
  device's public key during enrollment.
- Endpoints: `POST /print` (ESC/POS receipt from a structured payload, never raw bytes from the
  network), `POST /drawer/open`, `GET /scale/weight`, `GET /health`.
- If the bridge is unavailable, the PWA falls back to the browser print dialog and shows a warning.

## 9. Errors, testing, observability

- **Error contract**: `{ code, message, details?, correlationId }`, typed in `shared/`. No stack
  traces or internal messages to clients. A correlation id is generated at the edge and propagated
  through logs and audit events.
- **Unit tests** (Jest/Vitest): pricing and tax engine, sync conflict logic, hash chain, permission
  resolution. These are written test-first.
- **Integration tests**: against real Postgres (Testcontainers) with RLS enabled, including a
  dedicated cross-tenant leakage suite that, for every tenant-scoped table and endpoint, asserts
  tenant A can never read or write tenant B's rows.
- **E2E**: Playwright for login, device enrollment, checkout, refund with step-up, going offline,
  selling offline, reconnecting, and verifying the server state.
- **Observability**: structured JSON logs (pino), `/health` and `/ready` endpoints, error capture
  hook (Sentry-compatible), BullMQ job dashboards in the super-admin console.

## 10. Milestones

Each milestone gets its own implementation plan and is shippable on its own.

1. **Foundation**: repo + npm workspaces, docker-compose (Postgres, Redis, Caddy), Prisma schema
   for platform + identity + org, RLS policies and leakage tests, auth (passwords, MFA, PIN,
   refresh rotation), device enrollment and request signing, audit log, super-admin console for
   tenants, domains, business types, and modules, plus a tenant back-office shell.
2. **Core POS (online)**: catalog, tax engine, checkout, cash and external card-terminal payments,
   receipts via the hardware bridge, shifts and cash counts, returns and refunds with step-up, basic
   sales reports.
3. **Offline mode**: PWA service worker, encrypted IndexedDB, down-sync, outbox up-sync, hash
   chain, quarantine workflow.
4. **Retail modules**: variants, barcodes and scanning, promotions, customers, loyalty.
5. **Restaurant modules**: tables, modifiers, kitchen display, split bills, tips.
6. **Grocery and pharmacy modules**: weighed items and scales, batch and expiry, prescriptions.
7. **Business**: multi-store, purchasing and receiving, stock transfers, advanced reports, tenant
   billing and plan enforcement.

## 11. Out of scope (for now)

- Integrated card acquiring (card payments go through an external terminal; amounts are recorded,
  not processed). Integrations with Sri Lankan payment providers are evaluated in Milestone 7.
- Native mobile apps (the PWA covers tablets).
- Accounting-software integrations and e-commerce sync.
- Schema- or database-per-tenant isolation (the data layer stays clean enough to move a large
  tenant to its own database later as a premium tier).

## 12. Tech stack summary

| Layer | Choice |
|---|---|
| Backend | NestJS (TypeScript), Prisma ORM |
| Database | PostgreSQL 16 with RLS |
| Cache / queues | Redis 7, BullMQ |
| Frontend | Angular (standalone components, signals), Angular service worker, Dexie |
| Shared | TypeScript, Zod |
| Hardware bridge | Node.js, `node-thermal-printer` / ESC/POS, `serialport` |
| Edge | Caddy (on-demand TLS) |
| Testing | Jest (backend), Vitest/Jest (frontend), Testcontainers, Playwright |
| Local dev | Docker Compose |
