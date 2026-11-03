# POS Platform

Multi-tenant, zero-trust point-of-sale SaaS. Design: `docs/superpowers/specs/2026-11-02-pos-platform-design.md`.

## Layout

| Folder | What |
|---|---|
| `backend/` | NestJS 12 API (ESM), Prisma 7, PostgreSQL 16 with row-level security |
| `shared/` | Types, Zod schemas, module and permission registries shared by API and apps |
| `frontend/` | Angular 22 workspace: `admin` (super-admin console + tenant back office), `pos` (till PWA), `ui` (shared components) |
| `infra/` | Docker Compose: Postgres, Redis, Caddy edge |
| `docs/` | Specs and implementation plans |

## Run it locally

Requires Node ≥ 22 and Docker.

    npm install
    npm run infra:up                       # postgres + redis
    npm run env:dev -w backend             # writes backend/.env with fresh keys (once)
    npm run build:shared
    npm run prisma:generate -w backend     # generates backend/src/generated/prisma (git-ignored)
    cd backend && npx prisma migrate deploy && cd ..
    npm run db:seed -w backend             # plan "standard" + retail/cafe/grocery/pharmacy
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

Optional TLS edge (Caddy, internal CA): `docker compose -f infra/docker-compose.yml --profile edge up -d caddy`.
It forwards `/api` to :3000, `/pos/*` to :4201 and the rest to :4200; start the dev servers with
`-- --host 0.0.0.0` so the container can reach them.

## Test

    npm test            # shared + backend + frontend unit tests (needs infra:up)
    npm run e2e         # Playwright: the whole Milestone 1 flow in a browser against the real API

The backend suite runs against the `pos_test` database and Redis DB 1. Notable suites:
`rls.spec.ts` (database-level isolation and the "every tenantId table has RLS" guard),
`leakage.e2e.spec.ts` (API-level cross-tenant isolation), `audit.spec.ts` (tamper-evident log).

The E2E suite (`frontend/e2e`) uses the dev database with fresh slugs per run, creates its own super
admin through the real CLI, and starts the API and both dev servers if they are not already running.
First time only: `npm exec -w frontend -- playwright install chromium`.

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
