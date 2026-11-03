# Milestone 1b — Frontend Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-03-m1b-frontend-design.md`
**Branch:** `feat/m1b-frontend` (from `feat/m1a-backend-foundation`)
**Execution:** inline, TDD per task, one commit per task. Written as a task-level plan (files, tests, acceptance) rather than full code listings, under Niva's "complete everything" instruction; code decisions are recorded as rulings in the ledger.

## Global constraints

- Angular 22, standalone, signals, zoneless (`provideZonelessChangeDetection`), TS 6.0 inside `frontend/` only.
- `@pos/shared` imported for schemas, `buildSigningPayload`, `DEVICE_HEADERS`, `PERMISSIONS`, `MODULES`, error codes. No duplicated contracts.
- Access tokens in memory only; impersonation token in `sessionStorage` only; device private key non-extractable in IndexedDB.
- Every HTTP call goes through `/api` relative URLs (proxy in dev, Caddy in prod).
- No secrets logged to the console.

## Tasks

1. **Workspace scaffold.** `frontend/` Angular workspace (`ng new --no-create-application`), projects `ui` (library), `admin`, `pos` (applications, `pos` with `baseHref /pos/`); root `package.json` workspaces + scripts (`dev:admin`, `dev:pos`, `test:frontend`, `e2e`); proxy config; `allowedHosts` for `.pos.localhost`; Vitest unit-test builder. *Accept:* both apps build; `ng test` runs a trivial spec per project.
2. **`ui` foundations.** Tokens + base styles; `ApiError` + `toApiError()` mapping and `humanMessage()`; components button, field, card, table, badge, dialog, toast, shell, copy, qr, otp-input, empty. *Tests:* error mapping (validation details, 5xx correlation id, network failure), otp-input emits only 6 digits, copy writes clipboard.
3. **Admin core: realm, auth store, interceptor.** `realm()` from hostname; `AuthStore` (signal token, refresh de-dup, login/MFA/setup/logout for both realms by base path); `authInterceptor` (bearer, one refresh+replay on 401); guards; impersonation fragment intake. *Tests:* realm detection, concurrent 401s trigger one refresh, replay once only, fragment stripped and token kept in sessionStorage.
4. **Sign-in UI (both realms).** Login → MFA verify / MFA setup (QR + secret) → home; set-password page. *Tests:* component test for the state machine on each `LoginResult`.
5. **Super-admin console.** Tenants list/new/detail (status, business type, modules, domains, impersonate, delete) and business types list/editor. *Tests:* module override table computes base/override/resolved display; business type editor flags unmet dependencies with `missingDependencies`.
6. **Tenant back-office.** Shell with permission-filtered nav (from `/api/me/capabilities`), overview, stores, registers, roles, users (setup code shown once, set PIN), devices (enrollment code + countdown, revoke), audit (list + verify). *Tests:* nav filtering by permission; users page shows setup code once.
7. **POS device layer.** IndexedDB device store; `DeviceSigner` (keygen non-extractable, JWK export, sign payload); signing interceptor (serialises body itself); bearer + refresh with device headers; revoked-device handling. *Tests:* signature verifies with the exported public key over `buildSigningPayload`; interceptor hashes exactly the sent body; query string included in the signed path; revoked response wipes the store.
8. **POS screens.** Enrol, PIN pad, till ready, lock. *Tests:* PIN pad accepts 4–8 digits, clears on failure.
9. **Edge + E2E.** Caddyfile forwards `/pos/*` → :4201, rest → :4200; Playwright config starting API + both dev servers; global setup creates a super admin via the CLI and captures its setup code; spec covering the full spec §1 flow, cross-realm refusal, and device revocation. *Accept:* `npm run e2e` green.
10. **Docs + verification.** README frontend section; full `npm test`, `ng build` both apps, `npm run e2e`.
