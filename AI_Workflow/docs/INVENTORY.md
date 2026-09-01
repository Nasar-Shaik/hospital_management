# General Store (G1/G3) — what v1 is, and what it deliberately is not

**Status: v1 complete, 2026-08-20.**

---

## The workflow, in one line

**Store keeper adds a supplier → adds an item → receives a delivery → the shelf rises → a
department asks for supplies → the store issues → the shelf falls → the list says what to reorder.**

Three verbs — **receive, issue, adjust** — one shelf per site, one append-only ledger. That is the
whole module.

---

## Why this module and not another

The [product audit of 2026-08-20](../projectTracker.md) measured every major HMS area against the
current code and found the general store to be the only **core operational department with no
software at all**. Every hospital of every size consumes gloves, syringes, IV sets, sutures, gauze
and linen daily, and it is their largest non-salary cost. Before this, the product could not answer
_what is on the shelf, who did we buy it from, for how much, or what must be reordered_ — for
anything that is not a drug.

It also had the shortest path to a working V1: the permissions were already declared, the pattern
was already proven next door in the pharmacy, and four other modules (CSSD, biomedical waste, asset
spares, procurement) sit downstream of it.

---

## What it reuses, and the one place it diverges

The shape is the pharmacy's, deliberately: a master, a running balance, and an append-only signed
ledger that explains it. Reusing that pattern is why this module is small.

What it does **not** reuse is the pharmacy's tables. A glove is not a drug: it has no form, no
strength, no generic name, it must never appear on a prescribing pad, and
`GET /medicines/availability` must never offer it to a doctor. Putting consumables into `medicines`
would put them in all of those places.

**The one deliberate divergence: the balance is per site.** The pharmacy holds one hospital-wide
`stockUnits`, because splitting an existing balance between sites needs an answer nobody has. That
objection does not reach here — these collections are new, there is nothing to divide — and the
positive case is stronger: a store is a **room**. One shared number would make "we have 400 gloves"
true of a hospital where one site has 400 and the other has none, and the reorder flag would be
unanswerable. So `inventoryStock` holds one row per (item, branch) and the master carries no
balance at all, which also removes the mirror the pharmacy has to keep in step.

---

## The one rule this module has that the pharmacy does not

**The shelf cannot go below zero.**

The pharmacy allows a negative balance and reports it as `reconcile`, because the drugs have
already crossed the counter by the time the ledger hears about it and a bookkeeping problem must
never hold a patient's medicine.

Nothing of the kind is true here. Nobody is standing at a counter; the store keeper is holding the
box and can count it. An issue of forty from a shelf of thirty is not an event that already
happened — it is a mistake being made right now, and refusing it (`HMS-INV-002`) is how the keeper
finds out before the ward does.

It is arbitrated by the **database**, not by a read-then-check-then-write: taking stock out is a
conditional update requiring `onHand >= quantity`. Two keepers reaching for the last thirty boxes
at the same instant therefore cannot both succeed. Proven under concurrency in
`inventory.int.test.ts` §1, and falsified — removing the condition turns four integration tests and
the browser's negative path red.

---

## Authorization — four jobs, not four ranks

| Permission           | What it is for                                                      | Scope    |
| -------------------- | ------------------------------------------------------------------- | -------- |
| `inventory:manage`   | The item master and the shelf. Baseline: every READ is gated on it. | `branch` |
| `inventory:purchase` | Book a delivery in, against a supplier                              | `branch` |
| `inventory:issue`    | Hand stock out to a department                                      | `branch` |
| `inventory:audit`    | Correct the count after a stock-take                                | `branch` |
| `vendor:manage`      | The supplier master                                                 | `tenant` |

All five were declared `future()` until this milestone and **all five were held by TENANT_ADMIN
alone** — the fifth instance of "a permission nobody holds is a feature nobody has" in this
codebase. `STORE_KEEPER` is the role that makes them reachable by the person whose job this is.

Two of these are worth stating explicitly:

- **`audit` is separate from `issue` on purpose.** A clerk who can both take stock out AND rewrite
  the number to match leaves no shortfall anybody can see.
- **All four are `branch`, and that is not cosmetic.** The scope declared in the catalogue _is_ the
  row-scoping level. Three of them were written `tenant` (copied from the entries that predated the
  module) and this module's own integration suite caught it on the first run: a keeper bound to the
  annexe, sending no branch header, was answered with the SUM of both sites' shelves. The
  permission looked confining and confined nothing.

**`STORE_KEEPER` holds nothing clinical.** No `patient:read`, no `emr:read`. That is why
`GET /inventory-destinations` exists: `GET /departments` is gated on `patient:read` — a proxy that
was correct while every caller was clinical, and that breaks on the first caller who is not.
Granting a store keeper the whole patient list so a picker could be filled in would have been the
exact broad-grant mistake the catalogue exists to prevent. The store answers its own question,
under its own permission, with an id and a label and nothing else.

---

## Entitlement

`module.support.inventory`, in the Hospital, Hospital Plus and Enterprise editions. Deliberately
separate from `module.pharmacy.full`: they are two rooms with two keepers, and a clinic that bought
the dispensing counter has no store keeper. Every route carries it, reads included, so an
unentitled hospital gets `HMS-PLAN-002` and the navigation never offers the screen (D20).

---

## What is NOT built — deliberately, not accidentally

Listed so nothing here reads as an oversight. **None of these is planned for v1.**

**Procurement:** purchase orders, approval chains, tenders and rate contracts, three-way invoice
matching, supplier performance scoring, an accounts-payable ledger, reorder suggestions and
automatic purchasing.

**Warehousing:** sub-stores and bins, multi-warehouse hierarchies, inter-branch stock transfer,
consignment stock, kits and bills of material, barcode or RFID hardware.

**Analysis:** ABC/VED classification, EOQ, consumption forecasting, stock valuation and period
close.

**Batches and expiry.** A consumable is not a drug: the pharmacy earned its batch model because
expiry is a patient-safety control there. Some store items do expire (sutures, some solutions), and
when a hospital asks, the pharmacy's `medicineBatches` shape is the one to copy. Not before.

**Patient-level consumable billing.** A `procedure` order already bills through the tariff; charging
the individual glove is a different product.

**The pharmacy's own purchasing.** `pharmacy:purchase` stays `future()`. The supplier master now
exists and the drug shelf could be wired to it — but that is a change to the pharmacy, and the
pharmacy is frozen.

---

## Test coverage

| Layer                        | What it proves                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inventory.int.test.ts` (33) | The shelf never goes negative (boundary, concurrency, both directions); the ledger reconciles; the shelf belongs to a site; stock arrives somewhere nameable; tenant, entitlement, RBAC and idempotency boundaries |
| `rbac.int.test.ts`           | All eleven routes probed across every seeded role — including that STORE_KEEPER can work and cannot read a patient                                                                                                 |
| `generalStore.test.tsx` (12) | The page renders the server's numbers rather than recomputing them; the D19 branch guard; the D20 edition refusal; each permission gates its own control; the idempotency header is actually sent                  |
| `inventoryStore.spec.ts` (2) | A delivery received and issued in a real browser, with the ledger explaining both; and the over-issue refusal reaching a person in words                                                                           |

**Eleven falsifications** were run and reverted — negative shelf, branch read, branch write,
destination validation, provenance capture, entitlement, permission scope, ledger balance, and the
three client-side guards. Each turned red the tests that claim to defend it.
