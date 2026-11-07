# POS Platform

Multi-tenant, zero-trust point-of-sale SaaS. Design: `docs/superpowers/specs/2026-11-02-pos-platform-design.md`.

## Layout

| Folder | What |
|---|---|
| `backend/` | NestJS 12 API (ESM), Prisma 7, PostgreSQL 16 with row-level security |
| `shared/` | Types, Zod schemas, module and permission registries shared by API and apps |
| `frontend/` | Angular 22 workspace: `admin` (super-admin console + tenant back office), `pos` (till PWA), `ui` (shared components) |
| `hardware-bridge/` | Local service on each till: ESC/POS receipts, cash drawer, scale; obeys only its paired device |
| `infra/` | Docker Compose: Postgres, Redis, Caddy edge |
| `docs/` | Specs and implementation plans |

## What it does

| Milestone | Features | Notes |
|---|---|---|
| 1 Foundation | Tenants, domains, business types, modules; passwords, MFA, PINs; device enrolment and request signing; audit log | `specs/2026-11-02-*` |
| 2 Core POS | Catalog, VAT/SSCL tax engine, cash/card/split payments, receipts, shifts and Z reports, voids and refunds with manager approval, reports | `specs/2026-11-07-m2-core-pos.md` |
| 3 Offline | PWA, encrypted local store, down-sync, signed hash-chained outbox, offline PIN sign-in and approvals, quarantine review | `specs/2026-11-07-m3-offline.md` |
| 4 Retail | Variants, barcodes and scanning, promotions, encrypted customers, loyalty points, store credit | `specs/2026-11-07-m4-retail.md` |
| 5 Restaurant | Modifiers, tables and open orders, kitchen display, split bills, tips | `specs/2026-11-07-m5-restaurant.md` |
| 6 Grocery and pharmacy | Weighed items, scale labels and scales, lots with expiry (FEFO, recall), prescriptions | `specs/2026-11-07-m6-grocery-pharmacy.md` |
| 7 Business | Multi-store and store prices, purchasing, stock transfers, margin and stock insights, CSV, plans and billing | `specs/2026-11-07-m7-business.md` |
| 8 Payments and offline | Online invoice payment (gateway interface, sandbox), card terminals through the bridge (interface, sandbox), offline shift open/close, refunds, voids, customers, points and store credit | `specs/2026-11-08-m8-payments-offline.md` |

Features are switched on per tenant by modules (business type plus console overrides); the API refuses
disabled modules and the apps hide them.

## Run it locally

Requires Node ≥ 22 and Docker.

    npm install
    npm run infra:up                       # postgres + redis
    npm run env:dev -w backend             # writes backend/.env with fresh keys (once)
    npm run build:shared
    npm run prisma:generate -w backend     # generates backend/src/generated/prisma (git-ignored)
    cd backend && npx prisma migrate deploy && cd ..
    npm run db:seed -w backend             # plans standard/business + retail/cafe/grocery/pharmacy/retail-chain
    npm run platform:create-admin -w backend -- --email you@example.com --name "Your Name"
    npm run dev:api                        # http://localhost:3000/api/health

Then the apps, each in its own terminal:

    npm run dev:admin                      # http://admin.pos.localhost:4200  (console)
                                           # http://<slug>.pos.localhost:4200 (tenant back office)
    npm run dev:pos                        # http://<slug>.pos.localhost:4201/pos/ (till)

`*.localhost` resolves to 127.0.0.1 in Chrome, Edge and Firefox, so no hosts-file edits are needed. The
admin app picks its side from the host: `admin.*` is the platform console, anything else a tenant.

First run, end to end: open the console, set your password with the code `platform:create-admin`
printed, enrol your authenticator, create a tenant, and open the setup link it shows. The owner then
adds a store, a register, a cashier with a PIN, and an enrollment code under Devices; enter that code
on the till.

Receipt printer (optional): on the till computer run `npm run dev:bridge` (prints to the console) or copy
`hardware-bridge/bridge.config.example.json` to `bridge.config.json` with your printer and run
`node hardware-bridge/dist/main.js`. Pair it from the till's Shift tab with the 6-digit code the bridge prints.
Without a bridge the till prints through the browser. A scale can be added to the bridge config:
`{ "type": "tcp", "host": "...", "port": 4001 }`, or `{ "type": "serial", "path": "COM3" }` after
`npm install serialport -w hardware-bridge` on that till. A card terminal goes under `"terminal"`: only the
sandbox exists so far (`{ "type": "sandbox" }`, the default with `--dev`; amounts ending in 13 cents are declined).
Real terminals are drivers implementing `CardTerminal` in `hardware-bridge/src/terminal.ts`.

The till works offline once it has synced: production builds (`npm run build -w frontend`) include a service
worker for the app shell; in dev the app still needs the dev server. Billing runs daily at 02:00 (Colombo);
super admins can run it at once from Console → Invoices. Owners pay invoices online under Plan and billing:
outside production that goes to the sandbox gateway (`BILLING_GATEWAY=sandbox`, a test page with Pay and
Decline). For PayHere set, in `backend/.env`: `BILLING_GATEWAY=payhere`, `PAYHERE_MERCHANT_ID`,
`PAYHERE_MERCHANT_SECRET` (both from a free sandbox merchant account at sandbox.payhere.lk) and
`PAYHERE_NOTIFY_URL=https://<public api host>/api/platform/billing/webhooks/payhere`; the notify URL must be
reachable from the internet. `PAYHERE_SANDBOX=false` switches to live PayHere.

Optional TLS edge (Caddy, internal CA): `docker compose -f infra/docker-compose.yml --profile edge up -d caddy`.
It forwards `/api` to :3000, `/pos/*` to :4201 and the rest to :4200; start the dev servers with
`-- --host 0.0.0.0` so the container can reach them.

## Test

    npm test            # shared + bridge + backend + frontend unit tests (needs infra:up)
    npm run e2e         # Playwright: each milestone's flow in a browser against the real API

The backend suite runs against the `pos_test` database and Redis DB 1. Notable suites:
`rls.spec.ts` (database-level isolation and the "every tenantId table has RLS" guard),
`leakage.e2e.spec.ts` (API-level cross-tenant isolation), `audit.spec.ts` (tamper-evident log),
`pos.e2e.spec.ts` (selling, approvals, refunds, shifts), `sync.e2e.spec.ts` (offline chain, quarantine),
`payments-offline.e2e.spec.ts` (offline shifts, voids, customers, terminal cards, online invoice payment),
`retail`, `restaurant`, `grocery-pharmacy` and `business` suites per milestone. The pricing, promotions,
modifier, FEFO and scale-label engines are tested in `shared/src/*.spec.ts`.

The E2E suite (`frontend/e2e`) uses the dev database with fresh slugs per run, creates its own super
admin through the real CLI, and starts the API and both dev servers if they are not already running.
First time only: `npm exec -w frontend -- playwright install chromium`. `npm run e2e` clears the Vite
dependency cache first, because a stale prebuilt `@pos/shared` otherwise serves old exports.

## Security model in one paragraph

Every request resolves its tenant from the Host header, then passes one guard chain: realm →
tenant status → user token (EdDSA, 5 min) → device signature (ECDSA P-256, nonce + clock skew)
→ module enabled → permission → manager step-up. Tenant data is only reachable inside
`TenantDb.run`, which sets a transaction-local `app.tenant_id`; Postgres RLS filters everything
else, and composite `(tenantId, id)` foreign keys stop cross-tenant references. Every sensitive
action lands in a per-tenant hash-chained audit log the app role cannot update or delete.

## Adding a tenant-scoped table

1. Give it `tenantId` and `@@unique([tenantId, id])`; relate to other tenant tables with composite keys.
2. Add it to an RLS block in a new migration (copy `prisma/migrations/*_rls/migration.sql`).
3. `rls.spec.ts` fails until you do.

Migrations are written as SQL and applied with `prisma migrate deploy`. `prisma migrate diff` is a
useful starting point, but it does not know the `sync_version` sequence or the hand-written composite
foreign keys (constraint names without `tenantId`) and will try to drop them; remove those lines.
Tables the tills down-sync carry a `version` column from `sync_version` with an update trigger.
