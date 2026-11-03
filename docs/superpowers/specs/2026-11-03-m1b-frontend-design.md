# Milestone 1b — Frontend Design

**Date:** 2026-11-03
**Status:** Decided by FRIDAY under Niva's standing instruction "complete everything and report"; open for review.
**Parent spec:** `2026-11-02-pos-platform-design.md` (§2 layout, §3 runtime components, §4 security, §5 configurability, §10 milestone 1).
**Backend:** Milestone 1a (`feat/m1a-backend-foundation`), consumed as-is.

## 1. Outcome

Milestone 1's success criterion, minus the sale (which needs Milestone 2's checkout), done entirely in a browser:

1. A super admin signs in (password + TOTP) on `admin.<platform-domain>`, creates a business type if needed, creates a tenant, and receives the owner's one-time setup code.
2. The owner opens `<slug>.<platform-domain>`, sets a password with the code, enrols TOTP, and in the back-office creates a store, a register, a cashier with a PIN, and a device enrollment code.
3. On the till, the POS app at `<slug>.<platform-domain>/pos/` enrols itself with that code (non-extractable ECDSA P-256 key in IndexedDB), shows the PIN pad, and the cashier signs in to a "till ready" screen. Every POS request is device-signed.

A Playwright test drives exactly this flow against the real API and is the acceptance gate.

## 2. Decisions

| Topic | Decision | Why |
|---|---|---|
| Framework | Angular 22, standalone components, signals, zoneless | Spec §12; current major |
| Workspace | `frontend/` single Angular workspace, npm workspace member; projects `admin`, `pos`, `ui` | Spec §2 |
| TypeScript | Frontend uses TS 6.0 (Angular 22 requires it); backend stays on 5.9 | npm nests per-workspace versions |
| UI kit | Own small component set in `ui` on CSS custom properties; no Angular Material | Few components needed; no theming fight; keeps bundle small and the look ours |
| QR for TOTP enrolment | `qrcode` package renders the `otpauth://` URL; secret also shown as text | Phones need a QR; text is the fallback |
| `pos` scope | Enrollment, PIN pad, "till ready" screen, lock, revoked-device handling | Proves the device-signing chain; till UI arrives with checkout (M2) |
| Step-up UI | Deferred to M2 | No M1 route requires step-up; nothing to test it against |
| Offline / service worker | Deferred to M3 | Spec §10 |
| Unit tests | Vitest via `@angular/build:unit-test` | Angular 22 default |
| E2E | Playwright (Chromium), real API on the dev database, unique slugs per run | The acceptance gate |

## 3. Hosting model

- **Admin app** is one bundle served on every host. At bootstrap it reads `location.hostname`: `admin.<platform-domain>` → super-admin console routes; anything else → tenant back-office routes. The backend's realm check is authoritative; the split is UX.
- **POS app** is served under `/pos/` on tenant hosts (`baseHref: /pos/`).
- **Dev:** `ng serve admin` on :4200 and `ng serve pos` on :4201, both proxying `/api` to `localhost:3000` without rewriting `Host` (the API strips the port). `*.localhost` resolves to 127.0.0.1 in Chromium, so `http://acme.pos.localhost:4200` works with no hosts-file edits. The Caddyfile's catch-all forwards `/pos/*` to :4201 and everything else to :4200.
- **Cookies:** the refresh cookie (`pos_rt`, path `/api/auth`) is per host, not per app. A browser running both the back-office and the till on one tenant host shares one refresh cookie; the last sign-in wins. Acceptable: tills run only the POS.

## 4. Auth handling in the browser

- Access tokens live in memory only (a signal in the app's auth store). Never in `localStorage`.
- On load, each app calls its refresh endpoint once (`/api/auth/refresh` or `/api/platform/auth/refresh`); success restores the session silently.
- An HTTP interceptor adds `Authorization: Bearer`; on a 401 with `UNAUTHENTICATED` it tries one refresh, replays once, otherwise routes to login. Refresh calls are de-duplicated (one in flight), because the backend treats concurrent reuse of a refresh token as theft.
- Login flow follows the API's `LoginResult`: `ok` → in; `mfa_required` → 6-digit code; `mfa_setup_required` → QR + secret + code. The super-admin realm always requires MFA.
- **Impersonation:** the console starts an impersonation, then opens `https://<tenant-host>/#imp=<token>` in a new tab. The back-office reads the fragment at bootstrap, strips it from the URL, keeps the token in `sessionStorage` (tab-scoped, lost on close), and shows a fixed banner "Impersonating — read the reason in the audit log" with an Exit button that discards the token. No refresh token exists for impersonation; after 30 min the API returns 401 and the tab shows "Impersonation ended". The fragment never reaches a server.

## 5. Device signing (POS)

- Enrolment: `crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])`, so the private key is **non-extractable**. Public key exported as JWK (`kty, crv, x, y` only) and sent with the code and a device name to `POST /api/devices/enroll`. `{ deviceId, registerId, privateKey, publicKey, name }` is stored in IndexedDB (CryptoKey objects are structured-cloneable).
- Every POS request goes through a signing interceptor: it serialises the JSON body itself (so the bytes hashed are the bytes sent), computes `sha256hex(body)`, builds the payload with `buildSigningPayload` from `@pos/shared` (method, path + query as sent, hash, unix seconds, random nonce), signs with ECDSA/SHA-256 (WebCrypto returns IEEE P1363, as the API expects), and sets the four `x-device-*` headers.
- `DEVICE_REVOKED` or "unknown device" (`DEVICE_SIGNATURE_INVALID` on `/devices/whoami` at boot) wipes the IndexedDB record and returns to the enrolment screen.

## 6. Screens

**Super-admin console (admin host):** Sign in · Set password (setup code from the CLI) · Tenants list (status, business type, slug) · New tenant (name, slug, business type, owner name/email; shows host + owner setup code once, with copy buttons) · Tenant detail: status (suspend/reactivate), business type change, modules (base/override/resolved per module, set or clear override; dependency errors shown inline), domains (add, TXT instructions `_pos-verify.<host>` = `pos-verify=<token>`, verify, remove), impersonate (reason ≥ 10 chars, optional user), delete (typed slug confirmation) · Business types list and editor (modules with dependency hints, role templates with permission checkboxes).

**Tenant back-office (tenant host):** Sign in · Set password (`/setup-password?code=…`, code also typeable) · Overview (who am I, tenant, enabled modules, permissions) · Stores · Registers · Roles (permission checkboxes; server enforces "only grant what you hold", UI shows the 403 detail) · Users (create with roles, optional email and PIN; shows the setup code once; set PIN) · Devices (create enrollment code for a register, shown large with expiry countdown; list; revoke) · Audit (latest events, verify chain). Nav items are hidden when the user lacks the permission (UX only).

**POS (tenant host, /pos/):** Enrol (code + device name) · PIN pad (users from `/api/users/pin-pad`, large touch targets, 4–8 digits) · Till ready (cashier, register, device; Lock → logout → PIN pad).

## 7. Components (`ui`)

`ui-button`, `ui-field` (label, hint, error; wraps a native input/select), `ui-card`, `ui-table` (simple, content-projected rows), `ui-badge`, `ui-dialog` (native `<dialog>`), `ui-toast` service, `ui-shell` (sidebar + top bar), `ui-copy` (value + copy button), `ui-qr`, `ui-otp-input`, `ui-empty`. Design tokens in `ui/styles/tokens.css`: neutral slate surfaces, one accent, 4 px spacing scale, system font stack, visible focus rings, AA contrast. Error display maps the API's `{ code, message, details, correlationId }` and always shows the correlation id on 5xx.

## 8. Error handling

One `ApiError` type in `ui` built from the API's error body. Forms show `VALIDATION_FAILED` details next to fields by `path`; `CONFLICT`, `FORBIDDEN` (with `details.missing`), `PLAN_LIMIT_REACHED`, `TENANT_SUSPENDED`, `ACCOUNT_LOCKED`, `RATE_LIMITED` get human messages. Network failure shows a retry toast. No stack traces or raw JSON in the UI.

## 9. Testing

- **Unit (Vitest):** device signer (payload, P1363 signature verifies with the public key, body hash of the exact bytes), auth store and refresh de-duplication, interceptors (bearer, single retry, signing headers), API error mapping, impersonation fragment handling, realm detection, module/permission nav filtering.
- **E2E (Playwright):** the §1 flow end to end, plus: a tenant user's token is refused on the admin host (UI lands on sign-in), a revoked device returns the till to enrolment.

## 10. Out of scope

Checkout and the real till UI (M2), step-up approval UI (M2), offline/service worker/encrypted IndexedDB (M3), platform RBAC, email delivery, production build/deploy pipeline, i18n.
