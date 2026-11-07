# Milestone 5: Restaurant modules, design notes

**Date:** 2026-11-07. Modules: `modifiers`, `tables`, `kitchen-display` (needs modifiers), `split-bill` (needs tables). Tips ride on `tables`.

| Topic | Decision |
|---|---|
| Modifiers | `ModifierGroup` (min/max selection) with `Modifier` options (price delta ≥ 0), linked to products in order. `chooseModifiers` in `shared` validates a choice the same way on the till, on the API and on offline sync. A line's list price is product price + deltas; an override still needs `price.override`. Removed options are switched off, never deleted (sales name them). Groups are versioned for down-sync; option and product-link changes bump the group or product. |
| Orders | Server-held `Order`/`OrderLine` per store, so every till and waiter sees the same tab; at most one open order per table (partial unique index). Lines go NEW → SENT → PREPARING → READY → SERVED; removing an unsent line is free, voiding a sent one needs a manager (`sale.void`), as does cancelling an order with sent items. Orders need the connection; quick-service selling (with modifiers) still works offline. |
| Paying | `POST /pos/orders/:id/pay` builds a sale from chosen order lines (any quantity left on each), re-priced from the current catalog through the same sale path (promotions, approvals, customers, loyalty). Paid quantity is tracked per line with an optimistic lock; the order closes when every line that was not voided is paid. Split by items = several payments of parts of the order; split evenly = several tenders on one sale. |
| Tips | `Sale.tip` on top of `due`; payments cover due + tip. Not revenue and not taxed; shift and sales reports show tips separately. Cash tips count toward the drawer because they are part of cash payments. |
| Kitchen display | A screen in the till app (`/kitchen`) for staff with `kitchen.view`; signing in with only that permission lands there. Polls every 4 s; tickets oldest first, red after 15 minutes; tapping an item moves it on. |
