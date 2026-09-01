# Permission lifecycle — the ledger, and the audit that produced it

**Status:** live. The rule is enforced by `apps/api/src/permissionLifecycle.test.ts`.

## The rule, in one line

> A permission with no `lifecycle` **must** be enforced by the shipped app. Anything else must say why not.

## Why this exists

`nursing:manage` was in the catalogue, granted to NURSE, and had a complete backend route
(`POST /encounters/:id/nursing-notes`, shipped M3-S2). No client ever called it. For two
milestones a nurse could not write a note, while the roles page told her employer she could. It
was found by hand.

`lab:collect` looks identical from the catalogue — granted to NURSE and LAB_TECHNICIAN, gating
nothing — and is entirely correct: specimen collection is M6 LIS work, and
`STATE_MACHINE_CATALOG.md` §7 is written and explicitly unimplemented.

**Counting routes cannot tell those two apart.** So the difference is declared on the permission
and checked against the app.

## The four states

|                    | Meaning                                                    | Must have a route?                    |
| ------------------ | ---------------------------------------------------------- | ------------------------------------- |
| _(no `lifecycle`)_ | **Active.** Enforced now.                                  | **Yes** — the gate fails otherwise    |
| `future`           | Reserved for an unbuilt module.                            | **No** — acquiring one fails the gate |
| `superseded`       | The capability shipped under a different code.             | **No** — same                         |
| `service`          | Enforced outside a router (service check or lookup table). | **No**, and the claim is verified     |

Codes are **permanent**: renaming one silently un-grants it from every role in every hospital's
database. That is why `superseded` exists at all instead of deletion.

## Adding a permission

Wire it to a route in the same change. If you cannot — the module is not built — pass a
`lifecycle`:

```ts
LAB_COLLECT: p("lab:collect", "Collect a sample", "branch",
  future("D6 LIS (M6)", "specimen collection — STATE_MACHINE_CATALOG §7 is written and explicitly not implemented; there is no specimen entity"),
),
```

The gate rejects a blank module, a reason under 20 characters, a `superseded` that does not name a
real and currently-routed replacement, and a `service` claim that no non-router source performs.
There is no allow-list to append to.

## What the audit found (2026-08-16)

**160 permissions · 85 active · 75 declared.**

Of the 75: **62 future**, **11 superseded**, **2 service**.

### Since then (2026-08-19)

**160 permissions · 87 active · 73 declared — 60 future, 11 superseded, 2 service.**

Two codes went live in the Theatre and Emergency milestones, and both had been sitting in the
catalogue held by somebody who could not use them:

| Code             | Was                                              | Now                                           |
| ---------------- | ------------------------------------------------ | --------------------------------------------- |
| `ot:record`      | `future` — "the operation record is not built"   | Gates `POST /ot-bookings/:id/operative-note`. |
| `triage:perform` | `future` — "the ED triage workflow is not built" | Gates `POST /emergency/triage`.               |

### And since then (2026-08-20)

**160 permissions · 92 active · 68 declared — 55 future, 11 superseded, 2 service.**

Five codes went live with General Stores v1, and every one of them was held by **TENANT_ADMIN
alone** — the fifth instance of the pattern below.

| Code                 | Was                                                | Now                                        |
| -------------------- | -------------------------------------------------- | ------------------------------------------ |
| `inventory:manage`   | `future` — "general stores inventory is not built" | Gates the store master and every read.     |
| `inventory:purchase` | `future` — "purchasing is not built"               | Gates `POST /inventory-items/:id/receive`. |
| `inventory:issue`    | `future` — "general stores inventory is not built" | Gates `POST /inventory-items/:id/issue`.   |
| `inventory:audit`    | `future` — "general stores inventory is not built" | Gates `POST /inventory-items/:id/adjust`.  |
| `vendor:manage`      | `future` — "vendors arrive with purchasing"        | Gates `/suppliers`.                        |

Three things the gate could not see, and they are again the interesting half:

- **A new role, `STORE_KEEPER`, ships with them.** Without it the fifth instance would have been
  the fifth: five permissions, eleven routes, a screen, and only the hospital administrator able to
  open any of it. The role holds those five codes and **nothing clinical** — no `patient:read`, no
  `emr:read` — which is what forced `GET /inventory-destinations` into existence rather than
  granting a store keeper the patient list to fill in a picker.
- **Three of the five were declared at the wrong SCOPE.** `inventory:manage`, `:purchase` and
  `:audit` said `tenant`, copied from catalogue entries written before the module existed. The
  scope declared here _is_ the row-scoping level (`authorize` publishes it as `scope.level`, and
  `scopeFilter()` narrows only on `"branch"`), so a keeper bound to one site, sending no branch
  header, was answered with the SUM of every site's shelf. The permission looked confining and
  confined nothing. Caught by the module's own integration suite on its first run — the ledger
  gate cannot see this, because a wrongly-scoped permission still gates a route.
- **`pharmacy:purchase` kept a reason that had become false** — the same failure as
  `ed:board:manage` below. It said "PROJECT_MEMORY records that the pharmacy has no inventory",
  which stopped being true at migration 0052. Rewritten to name what is actually missing: a
  pharmacy receipt names no supplier, cost or invoice.

Two more things were corrected that the gate cannot see, and they are the interesting half:

- **`ot:schedule` was granted to no clinical role.** It was active and correctly routed, so nothing
  here flagged it — the ledger checks that a permission gates something, not that anybody holds it.
  The result was a whole shipped module (theatres, bookings, the collision rule, the screen) that
  only the hospital administrator could reach. **A permission nobody holds is a feature nobody
  has**, and this is the fourth time. The DOCTOR and NURSE roles now carry it.
- **`ed:board:manage` kept a reason that had become false.** It still gates nothing and is still
  correctly `future`, but its reason said "the emergency board is not built" _after the board
  shipped_. The gate can see a `future` permission that acquires a route; it cannot see a
  declaration that has quietly stopped being true. Rewritten to name what is actually unbuilt: bay
  assignment and manual re-ordering.

### The two that a route census would have wrongly called orphans

Both are live authorization that `authorize()` cannot express, and both would have been "fixed"
by a naive gate:

- **`radiology:sign`** — `orders/order.authority.ts` requires it _on top of_ `order:verify`, so a
  pathologist cannot certify a CT scan and a radiologist cannot certify a blood culture.
- **`pharmacy:credit-override`** — checked in `pharmacy.service.ts` (HMS-PHM-003). It _cannot_
  gate the route: the pharmacist calling `dispense` is not the person authorising the credit.

### The eleven superseded codes

The capability shipped; the catalogue name did not survive contact with the design.

| Code                            | Actually enforced as                  | Why                                                  |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------- |
| `tenant:manage`                 | `hospital:manage`                     | the hospital profile is what an admin configures     |
| `record:read` / `record:write`  | `emr:read` / `emr:write` (+ `file:*`) | notes are EMR; uploads are documents                 |
| `discharge:create`              | `admission:discharge`                 | the summary is written by the act that ends the stay |
| `consultation:manage`           | `emr:write`                           | the consultation note is an EMR write                |
| `queue:manage`                  | `encounter:update`                    | the token queue is a state of the encounter          |
| `schedule:manage`               | `doctor:manage`                       | sessions are managed on the doctor                   |
| `notification:send`             | `notification:manage`                 | one permission covers templates and dispatch         |
| `package:manage`                | `tariff:manage`                       | a package is priced from the tariff                  |
| `lab:order` / `radiology:order` | `order:create`                        | ADR-0013 makes the Order polymorphic                 |

### Genuine F-2-style defects found: **none**

Every zero-route permission is future, superseded, or service-enforced. The six flagged as
suspicious in the brief (`emr:sign`, `consultation:manage`, `record:read`, `record:write`,
`referral:manage`, `discharge:create`) split cleanly: four are superseded, and `emr:sign`
(countersigning a note) and `referral:manage` (the referral register) are genuinely unbuilt.

## Open — one hazard, one decision

`seedRbac` writes **all 160** codes into every tenant (`syncPermissionCatalog(ALL_PERMISSIONS)`),
`GET /permissions` returns those rows, and `apps/web/app/roles/page.tsx` renders them. An
administrator building a custom role can therefore pick `record:write` or `emr:sign`, grant them,
and get nothing — the same "a permission is not a feature" confusion in a new place. Not a
security hole (they grant nothing), but it is a promise the product cannot keep.

`lifecycle` does **not** currently reach the API: the `Permission` contract lists its fields
explicitly and does not include it, which is why this change moved no contract.

**Decision required:** should the role editor be able to see this — by adding `lifecycle` to the
`Permission` contract and badging non-active codes, or by narrowing what is seeded? The first
changes an API response shape; the second changes what existing tenants hold. Either belongs in
its own slice. Until then, the eleven superseded codes remain selectable and inert.

---

## The same rule, one layer up: feature flags (2026-08-20)

**Status:** live. Enforced by `apps/api/src/featureLifecycle.test.ts`.

> A flag with no entry in `FEATURE_LIFECYCLE` **must** be read by shipped code. Anything else must
> say why not — and a declared flag must be read by nothing, so the declaration cannot rot.

A permission that gates nothing is a feature **nobody** has. A flag that gates nothing is a feature
**everybody** has — the mirror failure, and the more expensive one, because the thing it fails to
withhold is the thing with a price on it. Editions are not internal, either: `/subscription` lists
an edition's flags to the hospital under "Included in this plan".

This was found four times by hand before it became a test — `module.clinical.ris` (2026-08-18),
`module.clinical.emergency` (2026-08-19), and then two together:

- **`module.finance.packages`** sat in three editions and gated nothing. The six care-package
  routes carried `module.ops.opd` like the rest of billing, so every PLAN_HOSPITAL and PLAN_CLINIC
  tenant had a Day Care / Hospital Plus differentiator for free. Fixed by naming the flag the price
  list already named.
- **`portal.patient`** sat in `CLINIC_FLAGS`, which every edition extends, with no portal anywhere
  in the product. Fixed by removing it from the editions — not by building a portal.

### The four states

|                    | Meaning                                                                | Must gate something?                  |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------- |
| _(no declaration)_ | **Live.** A route's `feature`, or a check like `order.entitlement.ts`. | **Yes** — the gate fails otherwise    |
| `unbuilt`          | The module does not exist yet.                                         | **No** — acquiring a gate fails       |
| `bundled`          | Built, and in **every** edition, so it has no gate of its own.         | **No**, and every edition is checked  |
| `gated`            | Built, and withheld by a **different** named flag.                     | **No**, and the named flag is checked |

`bundled` and `gated` are the statuses worth distrusting: they are what a _missing_ gate would
claim about itself. So neither is believed. `bundled` is checked against every edition actually
carrying the flag — which is what stopped `module.finance.ipBilling` being filed there on the way
past; it is `gated` by `module.ops.ipd`, a different and verifiable claim. `gated` must name a flag
that exists, is itself live, and is held by every edition that sells the gated one.

### The ledger, not a failure

Eleven `unbuilt` flags are still listed in an edition — blood bank, critical care, dialysis,
physiotherapy, teleconsult, CSSD, pre-auth, inter-branch, multi-entity, dedicated DB, group
dashboards. That is legitimate: Enterprise sells inter-branch transfer as a contract somebody signs
for a department we are building. So the count is **pinned** exactly like the permission ledger's
idle count (12 → 11 when the portal left), and it should FALL as modules ship.

One rule is absolute, and it is the one `portal.patient` broke: **nothing unbuilt may be in the
flags every edition shares.** A premium edition's list is negotiated; the base bundle is not — every
customer receives it, and nobody signs for it.
