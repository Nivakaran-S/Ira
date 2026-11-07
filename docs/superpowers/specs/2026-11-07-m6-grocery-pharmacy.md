# Milestone 6: Grocery and pharmacy modules, design notes

**Date:** 2026-11-07. Modules: `weighed-items`, `batch-expiry`, `prescriptions` (needs batch-expiry and customers).

| Topic | Decision |
|---|---|
| Weighed items | `Product.soldByWeight`: the price is per kg and the quantity is a weight in thousandths (grams), which sales have used since Milestone 2, so pricing, tax, refunds and stock need nothing new. The till's weigh dialog reads the scale through the hardware bridge or takes a typed weight. |
| Scale labels | EAN-13 = prefix + PLU + value + check digit (`shared/src/scale-barcode.ts`), configured per tenant (`settings.scaleBarcode`: prefix, PLU digits, weight or price). Price labels become a quantity at the product's per-kg price; the line total can differ from the label by rounding of a minor unit. `Product.plu` is unique per tenant. |
| Scales | The bridge parses the common continuous formats ("ST,GS,+ 1.250kg", "W 01250 g", stable/unstable flags) from a TCP scale or a serial scale; serial needs the optional `serialport` package on that till. |
| Lots | `Batch(store, product, lotNo, expiresOn, qty)`; stock is received into lots (`RECEIVE` movements carry the lot). Sales of lot-tracked products take first-expiring-first and never from an expired lot (`allocateFefo`, shared); a shortfall is still sold (the sale is a fact; stock goes negative). Each sale line stores the lots it came from, which makes recalls a query (`GET /batches/:id/sales`). Voids and restocked refunds give quantity back to the latest-expiring lots the line used. |
| Prescriptions | `Prescription` (customer, prescriber, registration number, issue date) with items (product, quantity, directions, dispensed). Lines of `rxRequired` products need the customer on the sale and a prescription item for that customer and product, still within `pharmacy.rxValidDays`, with enough left; dispensing needs `prescription.dispense` or a manager approval. Dispensed quantity is tracked with an optimistic lock. Prescription medicines are never sold offline: the till refuses, and the server would quarantine (`RX_NEEDS_ONLINE`). |
