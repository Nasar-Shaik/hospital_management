# Payment policy — when money gates clinical work

**Status: decided, 2026-08-18.** This exists because two comments in the same file said opposite
things about the same rule, and neither matched the server.

---

## The rule, in one line

**The API gates nothing on payment. The web app holds unpaid outpatient laboratory work at the
worklist.** Those are two different statements, both true, and the difference is the whole point.

---

## What the API does

Nothing. `orders/order.service.ts` `transition()` walks `placed → accepted → in_progress →
completed → verified → released` with no payment check anywhere on the path, and there is no `paid`
field on the order. Any client holding `order:perform` can run an unpaid test.

That is **deliberate, and it is a safety decision**:

- A hard server gate refuses a **stat troponin** because a bill has not been finalized. The clock
  on a myocardial infarction does not wait for a cash counter.
- **Zero-tariff government hospitals are a target segment.** Their patients are charged ₹0, so a
  gate keyed on "has this been paid" makes every test at those hospitals unrunnable. (The
  `free` state exists precisely so those patients are never shown as "unpaid" and turned away.)
- A charge exists from the moment the order commits (`billing.consumers.ts` `onOrderPlaced`), and
  is reversed if the order is cancelled before work starts. **The money is never lost by not
  gating** — it is owed, visible, and collectable.

## What the API does provide

`GET /billing/order-payments?orderIds=…` returns `paid | unpaid | unbilled | free` per order.
A **status flag only, no amounts**, which is why it is gated on `order:read` rather than
`billing:read`: a technician must be able to see whether the test in front of them is paid for, and
they hold the worklist's permission, not the counter's.

`GET /billing/order-settlement` and `POST /billing/orders/:id/settle-from-advance` let an **admitted**
patient's test be drawn straight from the advance the desk already collected.

## What the web app does

`apps/web/app/worklist/page.tsx` holds the work. When an order's payment state is `unpaid` and its
status is `placed`, `accepted` or `in_progress`, the action buttons are replaced by
**"Awaiting payment — held until paid at billing"**.

What still proceeds:

| Case                           | Behaviour                                                 |
| ------------------------------ | --------------------------------------------------------- |
| `paid`                         | Normal actions                                            |
| `free` (zero-tariff patient)   | Normal actions — never shown as unpaid                    |
| `unbilled` (no charge yet)     | Normal actions                                            |
| Admitted patient, unpaid       | **"Proceed — deduct ₹x"**, settled from their advance     |
| Any state                      | **Cancel is always allowed**                              |
| Any other client (mobile, API) | Not held at all — this is a web policy, not a system rule |

## Where the money is collected

The chain is `order → charge → invoice → payment`, and a charge sits on **no bill** until somebody
finalizes one. That gap is what made an early build unusable: manual testing reported _"as a doctor
i have ordered blood tests, in lab technician login he is waiting for payment to proceed those
tests. i check in admin and cashier logins to pay those payments but i did not get option to pay
those."_ The money existed, was owed, and was invisible to the one person whose job is to collect
it.

The fix was **a screen, not a gate**: `GET /billing/pending` and the `/billing` pending panel, so a
cashier can raise the bill and take the payment. Pinned by
`billing.int.test.ts` → _"a cashier can find, bill and collect for care nobody has billed yet"_.

---

## The one thing this policy does NOT do — open product decision

**`stat` and `emergency` orders are held exactly like routine ones.** The hold condition reads the
payment state and the order status; it does not read `priority`.

This is recorded rather than patched because it is a product and clinical call, not an engineering
one. The two defensible answers:

1. **Exempt `stat`/`emergency` from the hold** — the priority already exists on every order, and
   the whole reason `priorityRank` is a number is that an emergency must not queue behind a routine
   cholesterol. A hospital that holds an emergency test for a bill has a clinical problem.
2. **Keep the hold and rely on the relief valves** — an admitted patient settles from advance, and
   an outpatient emergency is a walk to the counter. Some hospitals genuinely want this.

Whoever decides should also decide whether the exemption is a policy the hospital configures.
Until then the behaviour is as described above and the tests pin it as it is, not as it might be.

---

## What the tests prove

| Claim                                                 | Where                                                                       |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| The API runs an unpaid test end to end                | `orders.int.test.ts` — _"payment is visible to the lab, and gates nothing"_ |
| Payment state is visible to the technician            | same block, and the RBAC matrix on `/billing/order-payments`                |
| A cashier can bill and collect unbilled care          | `billing.int.test.ts`                                                       |
| The web hold, and every case that proceeds through it | `apps/web/__tests__/paymentHold.test.ts`                                    |
| Payment state does not widen tenant/branch scope      | `orders.int.test.ts` + `branchIsolation.int.test.ts`                        |
