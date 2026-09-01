# Pharmacy (F4/F5) — what v1 is, and what it deliberately is not

**Status: v1 complete, 2026-08-19.**

---

## Three things that are not the same thing

|                  | The question                                      | Where it lives                                                             |
| ---------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| **Prescription** | What does the doctor want the patient to receive? | `prescriptions.lines[].quantity`                                           |
| **Dispensing**   | What did the pharmacy actually hand over?         | `prescriptions.lines[].dispensedQty`, and one `dispenses` row per handover |
| **Billing**      | What should the patient be charged for?           | A charge per handover, at the quantity that crossed the counter            |

`ordered === dispensed` is never assumed. The gap between the first two columns **is**
`partially_dispensed`, and it is why the status is computed from the quantities rather than chosen.

---

## The workflow

**Doctor** prescribes → sees availability, is restricted by none of it → signs → a `pharmacy` order
appears on the counter → **pharmacist** opens it, hands over all or part of each line → stock falls
by batch, oldest expiry first → billing is told what actually crossed the counter → the doctor sees
`12/20 given` on the chart.

## Out of stock is not a refusal

A doctor may prescribe a drug the hospital has none of, one it has never stocked, and one that is
not on the medicine master at all. Availability is shown as **information**:

```
Paracetamol 500mg    · 120 in stock
Amoxicillin 500mg    · out of stock
```

The drug is still one tap away. The patient buys it outside, and the prescription is what they take
to the shop — a stock check that could block prescribing would turn an inventory problem into a
clinical one. `apps/web/__tests__/pharmacyStock.test.ts` refuses the patterns that would make it a
gate (a `disabled` bound to stock, a filtered list), because that change is one line and reads like
a kindness.

`GET /medicines/availability` is gated on **`prescription:create`**, not a pharmacy permission: a
doctor asking whether their patient can get a drug here is not doing inventory. The answer is a
code and a number — no price, no reorder level, no batch numbers.

## Two registers, one code

The prescribing pad lists the **tariff** (`category: "pharmacy"`); stock lives on the **medicine
master**, keyed on the same code. The seeded formulary is built from the pharmacy tariff so the two
agree. **A hospital adding a new drug must add it to both** — tariff to make it prescribable and
priced, master to track its stock.

---

## Batches and expiry

`medicineBatches` is one document per lot: `{medicineCode, batchNo, expiry, received, remaining}`.

- **Receipt** with a batch number _and_ an expiry creates or tops up a lot. One without the other is
  refused — a lot number with no expiry cannot be expired out, an expiry with no lot number cannot
  be recalled. Neither is fine: the stock goes on the running total, which is where every existing
  hospital's balance already sits.
- **Expired on arrival is refused.** Stock that may never be dispensed is not stock.
- **Dispensing takes FEFO** across in-date lots. Expired ones are excluded by the _query_, so there
  is no path that returns one to a caller who forgot to check.
- **A lot never goes negative.** The take is a conditional update (`remaining >= qty`), which is
  what arbitrates two pharmacists reaching for the same last box.

### When the batches cannot cover it

The handover still succeeds and the shortfall lands on the master's running total, which may go
negative and is reported as **`reconcile`** — "more went out than was ever booked in".

That is deliberate and it is this module's founding rule: _a bookkeeping problem must never hold a
patient's medicine._ The pharmacist is at the counter with the box in their hand; the drugs have
already crossed it by the time the stock consumer runs. Refusing would not un-give them — it would
only lose the record. A pharmacy whose shelf and books disagree needs to be **told**, not silently
corrected.

### Near expiry

90 days. A judgement, not a discovery: long enough that the stock can still be used or returned,
short enough that the list stays worth reading. The pharmacist's Batches view shows expired lots
**loudly** — they are excluded from dispensing, and somebody still has to go and pull the box.

---

## Stock is tenant-wide; movements are branch-stamped

Unchanged by this milestone, and stated because it is the question everyone asks next.
`scopedReads.test.ts` records the medicine master as **TENANT-WIDE** ("one hospital-wide price/stock
list, like `serviceItems`"), and a batch is stock _of_ a medicine. Every movement records the site
it happened at, so the ledger says which pharmacy did what.

**Splitting the balance per branch is a real product change** — it needs an answer to "how is an
existing balance divided?" — and this milestone does not invent one. It is the first thing to decide
if a customer runs two dispensing counters with separate shelves.

---

## What was already there, and was not rebuilt

Partial dispensing and the remaining quantity · the derived `partially_dispensed` status · the
over-dispense guard (`addDispensedQty` refuses in the query) · billing on the actual dispensed
quantity, per handover · `Idempotency-Key` and `requestId` replay, with `one_dispense_per_request_id`
as the arbiter · the credit override for an admitted patient over their advance · allergy screening
at prescribing · the dispensing ledger and history · stock adjustment with a reason, an actor and an
audit row · the low/out/reconcile stock report · the doctor seeing `dispensedQty/quantity` on the
chart.

## Not built, deliberately

Procurement · vendors · purchase orders · GRN · warehouses · multi-location stock · POS ·
substitution · insurance pharmacy claims · a drug-interaction engine · demand forecasting · barcode
hardware · supply-chain integrations.

**Barcode scanning** was evaluated and not built. The medicine search already accepts a typed code,
which is what a scanner emits — a hospital with a keyboard-wedge scanner can use one today without
a line of code. Anything more is device integration, and this milestone has no evidence about which
devices.

**Low-stock and expiry notifications** were evaluated and not built. Communication v1 delivers
messages _addressed to a person_, and "the pharmacy is low on amoxicillin" is addressed to a role.
Inventing a role-to-recipient rule for one alert would be the wrong place to decide it. The stock
report already ranks reconcile → out → low, and the Batches view marks expiry.

---

## Open decisions

1. **Per-branch stock.** See above. Needs a product answer before a technical one.
2. **Substitution.** A pharmacist cannot swap a drug, and should not silently. If it is wanted it
   needs its own workflow, authority and audit — not a quiet edit to somebody else's prescription.
3. **Writing a batch off.** Adjustment moves the running total, not a lot. Pulling an expired box is
   currently an adjustment plus a note; a per-lot write-off is small and worth doing when a hospital
   asks for it.

## What the tests prove

| Claim                                                           | Where                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| Lots, top-ups, half a batch refused, expired-on-arrival refused | `prescriptions.int.test.ts` — "stock is kept by batch…" |
| FEFO, spilling to the next lot, expired never allocated         | same block                                              |
| A lot cannot be over-drawn or drawn after it lapses             | same block, driven directly                             |
| Availability, and the fallback for an unbatched pharmacy        | same block                                              |
| A doctor may prescribe what the pharmacy has none of            | same block                                              |
| Only the pharmacy may receive, adjust or read the shelf         | same block, and the RBAC matrix                         |
| Adjustments carry a reason and an actor                         | same block                                              |
| Availability never becomes a restriction                        | `apps/web/__tests__/pharmacyStock.test.ts`              |
| The whole counter, in a browser                                 | `e2e/pharmacyDispensing.spec.ts`                        |
