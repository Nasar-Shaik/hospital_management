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
