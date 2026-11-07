# Milestone 8: Online payments, card terminals, fuller offline mode, design notes

**Date:** 2026-11-08. Follows Milestone 3 (offline) and Milestone 7 (billing). Payment providers sit behind interfaces. Invoices can be paid through PayHere (Sri Lanka) or a built-in sandbox; card terminals have a sandbox driver.

## Online invoice payment

| Topic | Decision |
|---|---|
| Shape | Hosted checkout. `BillingGateway` (`backend/src/modules/platform/payments`) creates a checkout session and verifies the provider's webhook. Card details never reach this server. |
| Flow | The owner presses Pay now (`billing.pay`, a new permission) → `POST /api/billing/invoices/:id/checkout` records a `BillingPayment` (PENDING) and returns the gateway URL → the provider calls `POST /api/platform/billing/webhooks/:provider` on the platform host → the signature is verified, the attempt is marked SUCCEEDED or FAILED once (a conditional update, so repeats and races change nothing), and a success marks the invoice paid (`paidRef = provider:paymentId`), which lifts a billing suspension as before. |
| Checks | Amount and currency must match the attempt, or it fails as `AMOUNT_MISMATCH`. A payment for an invoice already paid is recorded and audited as `invoice.paid_twice` for a manual refund. |
| Suspended tenants | Suspension for non-payment (`suspendedReason = 'billing'`) still allows signing in, `/me` and the billing page, so the owner can pay and come back straight away. Every other route answers `TENANT_SUSPENDED`. |
| Sandbox | `BILLING_GATEWAY=sandbox` (the default outside production; refused in production). Its "hosted page" is served by the backend at `/api/billing/sandbox/checkout/:session` with Pay and Decline buttons; the outcome becomes a webhook signed with a per-process HMAC key and goes through the same verification as a real one. The return path only accepts paths on the same host. |
| PayHere | `BILLING_GATEWAY=payhere` with `PAYHERE_MERCHANT_ID`, `PAYHERE_MERCHANT_SECRET` and `PAYHERE_NOTIFY_URL`; `PAYHERE_SANDBOX` (default true outside production) picks sandbox.payhere.lk, where test merchant accounts are free. The checkout API returns PayHere's URL and the signed form fields (`hash = MD5(merchant_id + order_id + amount + currency + MD5(secret))`); the billing page posts them. PayHere posts the outcome to the notify URL, verified with `md5sig`: status 2 pays the invoice, 0 waits, negative codes fail the attempt. The notify URL must be reachable from the internet, so on a laptop the invoice only turns paid once that URL is public (a deployed API or a tunnel). The secret never leaves the server. |
| Adding a provider | Implement `BillingGateway` (`createCheckout`, `parseWebhook` with the provider's signature scheme), add its key to `BILLING_GATEWAY` in `config/env.ts`, and provide it in `platform.module.ts`. |

## Card terminals

| Topic | Decision |
|---|---|
| Shape | ECR integration through the hardware bridge: `CardTerminal` (`hardware-bridge/src/terminal.ts`) with `sale` and `refund`; the bridge exposes `POST /terminal/sale` and `/terminal/refund` to the paired till only (device-signed, like printing). |
| Idempotency | Every request carries the till's reference; asking again with the same reference returns the first result and never charges twice. The till retries a lost answer once with the same reference. |
| Till | With a terminal on the bridge, Card in the payment panel becomes Charge card: the terminal is asked, and an approved result (scheme, last four digits, approval code, terminal reference) goes on the payment. If the sale is not recorded (an error, a cancelled approval, the panel closed), the charges are reversed on the terminal. Card refunds go back through the terminal against the original charge; the manager approves before the terminal pays anything back. Voiding a sale reverses its terminal card payments after the void is recorded. |
| Records | `Payment.card` and `Refund.card` keep the terminal result; receipts print `VISA ****4242` and the approval code. |
| Offline | A card approved by the terminal is a settled fact, so it is accepted offline whatever `offline.allowCard` says; that setting now covers only keyed-in cards and Other. |
| Sandbox | `{ "type": "sandbox" }` in the bridge config (the default with `--dev`) approves everything except amounts ending in 13 minor units, which are declined. Real terminals (bank ECR protocols) are drivers implementing `CardTerminal`. |

## Offline mode, extended

| Topic | Decision |
|---|---|
| New ops | `void`, `shift_open` and `shift_close` join `sale`, `refund` and `cash` in the signed, hash-chained outbox. A resent op is recognised by `Sale.voidOpId`, the shift id, and `Shift.closeOpId`. |
| Shifts | A shift opened offline takes an id chosen by the till; the sales after it refer to that id and arrive after it, in chain order. Closing offline records the counted cash; the server computes the expected cash from its own ledgers when the op arrives, so the stored variance is the server's. The till shows its own running figures meanwhile (`offline/local-shift.ts`). An offline shift open while the server already has one open on the register is held for review (`CONFLICT`). |
| Refunds and voids | The till keeps a journal of its sales (online and offline, plus any it looked up) for 7 days in the encrypted local store. Offline sales choose their line ids, so they can be refunded before they have synced. Refunds stay within `offline.maxRefund` (now editable in Settings); voids always need a manager, as online, and only within the open shift. |
| Customers | Down-sync sends customers (name, last four digits, points, credit) changed since the cursor; a ledger entry bumps its customer's version by trigger, so balance changes reach the tills. Offline, customers are found by name or the last four digits, and new customers need a connection (their phone number would otherwise sit in the outbox and quarantine in clear). |
| Points and credit offline | Spends are checked against the synced balance less what this till has spent in ops still in the outbox. Another till may have spent the same balance meanwhile: the server re-checks under the customer lock and holds an overdrawn sale for review; a manager who accepts it lets the balance go negative (the goods are gone). |
| After reconnecting | The till pushes the outbox, then pulls again, so the shift and balances it shows are the server's. While ops are waiting, down-sync does not overwrite the till's own shift. |

## Known limits

- PayHere is implemented to its published checkout and notification spec and tested with signatures computed the same way, but has not yet been run against a live PayHere sandbox account. A chargeback (status -3) after an invoice was paid is only audited, not reversed.
- The card terminal has only the sandbox driver; no real terminal has been driven.
- Restaurant orders (tables, kitchen, paying an order) still need the connection.
- A shift opened offline that collides with one opened elsewhere on the same register can only be rejected; its sales then need re-entering.
