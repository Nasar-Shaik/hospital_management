# PROJECT STATUS — MediCore HMS

**Architecture & implementation audit.** A point-in-time report on what is actually built, measured
against the governance docs (`AI_Workflow/`) and verified by reading the code, running the quality
gates, and reading `git log` — not by trusting any tracker.

**Audited:** 2026-08-10 · **Branch:** `feature/0.1` (135 commits) · **Auditor:** independent review
session · **Method:** full doc read (59 files) → code read → gates executed → git history

> **How this file is used.** It is the "how much is built, and is it sound" snapshot. The decision
> log lives in [00-PROGRESS-TRACKER.md](AI_Workflow/PlanofActionforHMS/00-PROGRESS-TRACKER.md); the
> reasoning lives in [PROJECT_MEMORY.md](AI_Workflow/PROJECT_MEMORY.md). Update the verdicts here
> when a module or a gate changes state.

---

## Phase 1A — hardening (2026-08-10) · CLOSED

The audit below is preserved as written. This block records what has since changed, so the two are
never confused: **everything under §2 CRITICAL was found by that audit; four of the five are now
fixed.** Commits `e81d8ea` · `ca5386e` · `dfa2685` · `fb49561` · `022dafd` · `327f0c2`.

| Audit finding                              | State                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| C2 · release gate RED (2 failures)         | ✅ **Green — 1363/1363, 12/12 files** (was 1012 passed / 2 failed)                 |
| C3 · 68 routes with no authorization probe | ✅ Probed. None was unprotected; all 340 derived assertions pass. Grants reviewed. |
| C4 · payment lost-update                   | ✅ Fixed in the database, plus idempotency keys. Falsified.                        |
| H8 · PHI not redacted in logs              | ✅ Fixed at the logger choke point + the access log. Falsified.                    |
| C1 · CI has never run                      | ⬜ **Still open.** `main` is still at the initial commit; nothing has been merged. |
| C5 · no rate limiting                      | ⬜ Still open — Phase 2.                                                           |
| K6 · no observability                      | ⬜ Still open — Phase 3.                                                           |

**Gates re-run at close:** typecheck 17/17 · lint 17/17 · format ✅ · boundaries 0 violations
(539 modules) · unit 55 · integration **1363/1363**.

**One environmental caveat, recorded because it will be mistaken for flaky tests.** On this machine
the integration suite fails intermittently — wandering single-test 404/401s, sometimes whole files
with `ECONNREFUSED`. Root cause is **not** the code: `medicore-hms-mongo-1` is OOM-killed
(`Exited (137)`) under memory pressure from 31 running containers on a 7.75 GB Docker allocation.
Reproduced with and without the Phase 1A changes; green on every run where Mongo stays up.
**Raise the Docker memory allocation before enabling CI**, or the first thing the new pipeline
teaches everyone is to ignore it.

---

## 0. Executive summary

MediCore HMS is a **genuinely impressive, unusually disciplined codebase** — 94,755 lines across a
43-module modular monolith, with an architecture that is not merely documented but _enforced_
(0 boundary violations across 537 modules). The multi-tenancy, authorization and audit foundations
are of a standard most commercial HIS products never reach. The clinical loop runs end to end:
register → encounter → order → result → prescribe → dispense → admit → discharge → bill → report,
for both private and government (₹0-tariff) hospital types, through **one code path**.

It is also, right now, **not releasable**, for reasons that are cheap to fix but must not be
ignored:

| #   | Finding                                                                                          | Severity |
| --- | ------------------------------------------------------------------------------------------------ | -------- |
| 1   | **CI has never run on this work.** `main` sits at the initial commit; 134 commits are unmerged.  | CRITICAL |
| 2   | **The release gate is RED** — 2 of 1014 integration tests fail, incl. the RBAC coverage test.    | CRITICAL |
| 3   | **68 routes have no authorization probe** — the "unprotected route breaks the build" gate broke. | CRITICAL |
| 4   | **Payments have a lost-update defect** — concurrent/retried payments corrupt the `paid` total.   | CRITICAL |
| 5   | **No rate limiting exists anywhere in the API.**                                                 | CRITICAL |
| 6   | ~19 modules (≈40%) shipped with **zero behavioural tests**.                                      | HIGH     |
| 7   | Root docs (`README`, `PRODUCT-TOUR`) describe a product **three weeks behind** the code.         | HIGH     |

The gap between the quality of the _design_ and the state of the _delivery pipeline_ is the single
most important thing this audit found. The engineering is excellent; the release discipline lapsed
around 2026-07-28 and never recovered.

**Overall completion: ~62%** of a sellable v1 (see §8 for the per-area breakdown and reasoning).

---

## 1. Verified metrics

Everything below was counted from the tree on 2026-08-10, not quoted from a doc.

| Metric                           | Value                                                 | How verified                            |
| -------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| Total source                     | **94,755 LOC** (api 58,176 · web 28,884 · rest 7,695) | `find … \| xargs cat \| wc -l`          |
| Backend modules                  | **43**                                                | `ls apps/api/src/modules`               |
| Wired v1 routers                 | **38**                                                | `grep v1Router.use apps/api/src/app.ts` |
| Route declarations               | **256**                                               | grep over `*.routes.ts`                 |
| OpenAPI paths / operations       | **216 / 265**                                         | `apps/api/openapi.json`                 |
| OpenAPI request-body schemas     | **0** (component schemas: 1)                          | parsed the spec                         |
| Tenant migrations                | **45** (0001–0045)                                    | `tenantMigrations.ts`                   |
| Permission codes                 | **156**                                               | `packages/permissions`                  |
| Feature flags / editions / roles | **22 / 7 / 11**                                       | `packages/permissions`                  |
| Domain events                    | **22**                                                | `core/events/eventCatalog.ts`           |
| Web pages                        | **45**                                                | `find apps/web/app -name page.tsx`      |
| Admin pages                      | **1** (1,049 LOC single-file console)                 | `find apps/admin/app -name page.tsx`    |
| Commits                          | **135** (94 feat · 22 fix · 11 docs · 1 test)         | `git log`                               |

### Quality gates, executed this session

| Gate               | Result                                             |
| ------------------ | -------------------------------------------------- |
| `pnpm typecheck`   | ✅ 17/17                                           |
| `pnpm lint`        | ✅ 17/17                                           |
| `pnpm boundaries`  | ✅ **0 violations** (537 modules, 1,877 deps)      |
| `pnpm test` (unit) | ✅ 37/37                                           |
| `pnpm test:int`    | ❌ **2 failed / 1012 passed (1014)** — gate is RED |

---

## 2. CRITICAL findings

### C1 · CI has never run on any of this work

`main` is still at `be895e8 chore(repo): initialize Medicore HMS platform foundation`. All **134
subsequent commits** live on `feature/0.1`. `.github/workflows/ci.yml` triggers on
`push: [main]` and `pull_request` — and there is no PR. **The entire product has never passed CI.**

This is the root cause of C2, C3 and F6. Every safeguard the project built — the RBAC matrix, the
isolation suite, the format check — has been running only when someone remembered to run it locally,
and since ~2026-07-28 nobody did.

### C2 · The release gate is RED

```
Test Files  2 failed | 10 passed (12)
     Tests  2 failed | 1012 passed (1014)
```

**Failure 1 — `rbac.int.test.ts` › "every permission-protected route has a probe in the matrix"**

> `expected [ …(68) ] to deeply equal []`

**Failure 2 — `encounters.int.test.ts` › "re-registering a patient who is ALREADY HERE resumes their
visit"** — `POST /encounters/:id/investigations` returns **422, expected 200**.

Failure 2 is _not_ a product bug. Commit `9af6a33` (2026-07-30) deliberately added a guard requiring
at least one order before `awaiting_results` — a correct, well-reasoned change. It shipped **without
updating the test that covers the behaviour it changed**, violating Constitution §17 (Definition of
Done: "Code + tests green"). The fix is to place an order in the test's arrange step.

### C3 · 68 routes have no authorization probe

The README's proudest claim — _"a new unprotected route breaks the build"_ — is now false in
practice. The build _did_ break; it was simply never run. The 68 unprobed routes span every module
shipped after 2026-07-28:

`invoices/:id/discount` · `invoices/:id/refund` · `invoices/:id/payer-split` · `packages` (×3) ·
`package-enrollments` (×3) · `encounters/:id/transfer-bed` · `rooms` (×3) · `ambulances` (×3) ·
`ambulance-trips` (×3) · `assets` (×5) · `feedback` (×5) · `insurance-policies` (×3) ·
`insurance-claims` (×4) · `consultation` (×2) · `medication-administrations` (×2) · `lab-tests` (×4) ·
`consents` (×3) · `death-records` (×2) · `mrd/*` (×6) · `mortuary/*` (×4) · `hospital-profile` (×2) ·
`doctors/availability|leave` (×5) · `reports/revenue-leakage` · `reports/dues-ageing`

Every one carries an `authorize()` call (the suite detects them _because_ they are tagged), so these
are **not** unauthenticated holes. The risk is that **nobody has decided or verified which roles may
call them** — the exact class of bug PROJECT_MEMORY documents three times over (`user:read` for the
receptionist, `prescription:create` scope, `admission:create` held by nobody). Money-moving routes
(`discount`, `refund`, `payer-split`, `settle`) are in this list, and those are the ones where an
unverified grant is most expensive.

### C4 · Payments have a lost-update defect

`billing.service.ts:678 recordPayment()` reads the invoice, computes `paid = invoice.paid + amount`
in application memory, then `billing.repository.ts:804 addPayment()` writes:

```ts
{ $push: { payments: payment }, $set: { paid, status } }
```

`paid` is a **stale absolute**, not a `$inc`. There is no idempotency key on the route, no optimistic
lock, and no transaction on the non-wallet path.

Two ₹500 payments against a ₹1,000 invoice, concurrent or double-clicked:

- both read `paid = 0`, both compute `paid = 500`
- both `$push` — the `payments` array correctly holds **two** entries
- both `$set: { paid: 500 }` — the scalar says **₹500**, status stays `finalized`

**₹1,000 crossed the counter; the system records ₹500 and asks the patient to pay again.** The array
and the scalar disagree, and `paid` is what every collections/dues report reads. `addRefund()` has
the identical shape.

This violates Constitution §3.4 and §7 ("money/critical POSTs use idempotency keys"; "user-edited
aggregates use optimistic locking") — and it is inconsistent with the project's own standard
elsewhere: `orders` and `pharmacy.dispense` both carry a client-supplied `requestId` with a unique
index. Payments were simply missed. `recordPaymentSchema` has no `requestId` field at all.

> Note the project _knows_ this pattern. PROJECT_MEMORY: _"The double-billing invariant is an INDEX
> … At-least-once delivery is the DESIGN."_ The same reasoning was never applied to the counter.

### C5 · No rate limiting exists

`grep -rni "ratelimit|rate_limit|express-rate" apps/api/src` → **zero matches.** No package, no
middleware, no route class.

Contradicted by: Doc 04 §2.1 (chain includes `rateLimit`), Doc 04 §5.1 ("Rate limits per
tenant/user/API-key; 429 with Retry-After"), Constitution §8 ("Every route declares … rate-limit
class, audit category — boot fails otherwise").

Exposure, on a system with wildcard DNS and a public login:

- `POST /auth/login` — per-account lockout exists, but nothing caps attempts **across** accounts
  from one IP, so username enumeration/spraying is unthrottled.
- `POST /auth/refresh`, `/forgot-password` — unthrottled; the latter is an outbound-mail amplifier.
- Every list endpoint is capped at 100 rows but uncapped in **requests per second**.
- API keys (A9) have no per-key limit — the module's own notes list this as pending.

Negative host caching (`TENANT_MISS_CACHE_TTL_SECONDS`) closes the registry-DoS vector specifically,
which shows the threat was understood; the general control was never built.

---

## 3. Backend audit

### 3.1 Architecture quality — excellent

Consistency is the standout property. **Every one of the 43 modules** follows the identical file
set: `<name>.routes.ts · .controller.ts · .service.ts · .repository.ts · .model.ts · .schema.ts ·
index.ts` (+ `.consumers.ts` where it reacts to events). Doc 04 §2.2 is followed to the letter, and
the layering is real — controllers are thin, services hold logic and transactions, repositories are
the only place Mongoose is touched.

Boundary discipline is **CI-enforced and clean**: 0 violations across 537 modules. Cross-module
access goes through `index.ts` only; the graph is acyclic. Where the rule was inconvenient the design
was changed rather than the rule (identity split into `users` ← `auth`/`rbac`; `staff` as a
collection-less orchestrator; billing _listens_ to clinical events rather than being called by them).

The invariants that matter are enforced **by the database, not by `if` statements** — a maturity
marker that is rare:

| Invariant                       | Mechanism                                             |
| ------------------------------- | ----------------------------------------------------- |
| One doctor, one slot            | unique partial index `one_doctor_one_slot`            |
| One open encounter per patient  | unique partial index `one_open_encounter_per_patient` |
| One patient per bed             | unique partial index `one_open_stay_per_bed`          |
| No double-billing               | unique index `one_charge_per_cause`                   |
| Gap-free UHID / invoice numbers | atomic `$inc` on `counters`, inside the transaction   |
| One notification per cause      | unique index + a claim **lease**                      |

### 3.2 Module-by-module verdict

Legend: ✅ complete for MVP · 🟡 core built, named gap · 🔴 placeholder/absent · ⏭️ deliberately deferred

**A · Platform (9/9 ✅)** — the strongest layer in the codebase.

| Module                        | Verdict | Notes                                                                                                                                                                                   |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Tenants + operator console | ✅      | Master registry, Connection Manager (LRU, `useDb`, `dbUri` override), reserved slugs, platform identity in master DB with a `tid`-less token. Pending: impersonation, export/terminate. |
| A2 Subscriptions/editions     | ✅      | 7 editions as code, live usage metering, creation-point limits. `plan:manage` correctly SUPERADMIN-only. Pending: SaaS invoicing.                                                       |
| A3 Identity & auth            | ✅      | argon2id, JWT + rotating refresh w/ reuse→family revocation, TOTP MFA + recovery codes, lockout, password history, forgot/reset. Pending: SSO, passkeys.                                |
| A4 RBAC                       | ✅      | 156 permissions, 11 roles, three-layer authorize (entitlement→permission→row scope), live re-derivation via `perm:v2:{userId}`. **But see C3.**                                         |
| A5 Audit + outbox             | ✅      | Append-only (no update/delete path exists), auto plugin, gap-free `seq`, hash-chain anchors + verify CLI. Transactional outbox → relay → BullMQ.                                        |
| A6 Notifications              | 🟡      | Backend + templates + ledger + real SMTP tests. **No management UI.** SMTP is global env — not per-tenant.                                                                              |
| A7 Documents                  | 🟡      | Bytes stored **in MongoDB** (≤10 MB), not MinIO. Works; will not scale. No virus scan.                                                                                                  |
| A8 White-label                | 🟡      | Name/logo/accent live. **Custom-domain routing + TLS not built.** Emails unbranded.                                                                                                     |
| A9 API keys + OpenAPI         | 🟡      | Keys work (PAT model, SHA-256 digest). Spec has **0 request/response schemas**. No per-key scopes or limits.                                                                            |

**B · Organization (7 ✅ · 2 🟡 · 4 ⏭️)** — B1 profile, B2/B3 departments (with cycle-guarded
hierarchy), B4 wards→rooms→beds + free-bed board + bed transfer, B5 theatres (overlap guard in
service + unique index as race backstop), B6 ambulance, B7 assets, B10 feedback, B13 mortuary all
built and screened. B8 vendors 🔴 (insurance only). B9/B11/B12 ⏭️.

**C · Patient (5 ✅ · 2 🟡)** — C1 MPI is exemplary: UHID from an atomic counter inside the
registration transaction, duplicate detection that **refuses and explains** rather than guessing,
merge that marks-and-links and never deletes, chains refused. C2 profile/timeline/allergies ✅.
C3 consent + statutory death record ✅. C7 MRD/ICD-10 ✅. C4 referral-in/out 🔴. **C6 patient
portal 🔴 — not started.**

**D · Clinical (5 ✅ · 3 🟡 · 6 ⏭️)** — D1/D3 EMR + structured consultation note (typed diagnoses,
write-back to the encounter summary) ✅. D2 doctor roster (sessions + leave) ✅. D5 nursing MAR
charted against signed Rx lines ✅. D6 LIS ✅ with a two-person `completed → verified` rule and a
catalogue that pre-fills and auto-flags results. **D7 radiology 🟡 — orders flow through the generic
Order object; there is no RIS, no DICOM, no PACS.** D8 OT 🟡 — scheduling only, no intra-op record.
D9–D14 ⏭️.

_Also built:_ `drugSafety` — a pure, DB-free `screen()` over allergen classes, cross-reactivity and
interactions. Honestly scoped by its own authors as _"a net over 15 demo drugs, NOT a formulary"_.
The **severity ladder** (only a contraindication blocks; everything else warns) is the right call and
is the difference between a safety check and alert fatigue.

**E · Encounter/Queue (2 ✅ · 1 🔴)** — E0 Encounter is correctly the spine (ADR-0013), with policy
switches instead of `if (organizationType === …)` — and **a test greps the source to enforce that**.
E1 appointments ✅. **E2 work-queue engine (ADR-0014) is NOT BUILT** — `grep -ri workitem` finds only
comments. Each department's worklist is a direct query. _This tracker previously claimed E2 was
done; that was incorrect._

**F · Financial (4 ✅ · 2 🟡 · 2 🔴)** — F1 billing is the most sophisticated module: integer paise
throughout, `listPrice`/`amount` split so a ₹0 government charge still records what the care was
worth, per-calendar-day-started bed billing, per-branch invoice series, event-driven charge posting
so **nothing clinical depends on billing**. F2 insurance policies/claims/payer-split ✅. F3 packages
✅ / corporate billing 🔴. F4 pharmacy dispense + stock ledger ✅. F5 general store 🔴. F6 GL 🔴.
F7 HR/payroll 🔴. **Caveat: C4 above.**

**I · Reporting (2 ✅)** — 7 reports (collections, visits, doctor load, diagnostics, revenue leakage,
dues ageing, disease register) + a role-aware dashboard with drill-through. Composed in `reporting`,
aggregated by the owning module — a clean application of "one collection, one query site".

**G/H/J · Mobile, comms, AI — 🔴 0%.** Backend is genuinely mobile-ready (body tokens, host tenancy,
one typed client), so G is a client build.

### 3.3 API maturity — 🟡

**Strong:** consistent `/api/v1` envelope `{success,data,meta?,error?}`; codes from a governed table;
`traceId` propagation; every list capped at 100; self-describing middleware that makes the auth
surface machine-auditable (`pnpm --filter @medicore/api routes`).

**Weak:**

- **OpenAPI is a route map, not a contract.** 216 paths, **0 request bodies, 1 component schema.**
  Zod schemas exist for every DTO but are never projected into the spec. No client can be generated.
- **`packages/validation` is a 24-line stub.** Constitution §2.4 ("Zod → types → OpenAPI, one source
  of truth") holds inside the API and **breaks at the frontend boundary** — schemas live in
  `apps/api/src/modules/*/*.schema.ts` and are never shared.
- **`packages/api-client` is 4,367 LOC / 901 methods, hand-written.** PROJECT_MEMORY flagged this as
  "the highest-value non-feature work outstanding" at 69 routes. There are now 256. Every route
  requires a hand-edit in a second file, with nothing checking the two agree.
- **No idempotency middleware.** Migration 0004 creates `idempotencyKeys` — **nothing ever writes to
  it.** Per-module `requestId` indexes cover orders and dispense; payments are uncovered (C4).

### 3.4 Database maturity — ✅ strong

45 sequential, idempotent, per-tenant migrations with a fleet runner (`migrate --all`). Indexes ship
with their query shapes. Transactions used exactly where multi-document invariants exist and
deliberately not elsewhere ("a transaction around one write is ceremony"). Money is integer paise
everywhere. Soft-delete + `tenantId` stamping as defence in depth behind physical DB isolation.

Concerns: reports run **aggregation pipelines directly over OLTP collections** (11 across 6 modules)
— contradicting Constitution §2.6/§12 ("reads scale by projection; no OLTP aggregation for
dashboards"). Fine at clinic scale, a cliff at hospital scale. No read models exist.

### 3.5 Workers & async — 🔴 the weakest backend area

`apps/workers` is **173 lines**: a 60-second heartbeat and an `events` worker that only
acknowledges. Doc 04 §2.6 specifies eleven queues. **Every real consumer — notifications, billing,
allergies, documents, wallet, patient-merge — runs inside `apps/api`.**

The reason is documented and legitimate (consumers need the tenant registry + Connection Manager,
which `apps/workers` lacks). But the consequence is unmanaged: **all async work competes with request
latency in the API process**, and the horizontal-scaling story in Doc 04 §6.3 does not hold — scaling
the API scales the consumers with it, and the outbox relay is leader-elected so it does not scale at
all. Giving `apps/workers` a DB layer is the single highest-leverage infrastructure task.

### 3.6 Security posture

**Genuinely strong.** Physical DB-per-tenant isolation; host and token as two independent factors
(`HMS-TEN-003`); argon2id; refresh tokens stored as SHA-256 digests only; TOTP seeds AES-256-GCM at
rest; login is not an enumeration oracle; permissions re-derived per request so revocation is
immediate; denials audited; production invariants that **cannot be overridden** by env; reserved
slugs; no secrets committed; boot refuses without `API_JWT_SECRET`/`API_ENCRYPTION_KEY`.

**Gaps:**

| Gap                                                                                                                                                                 | Severity |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| No rate limiting (C5)                                                                                                                                               | CRITICAL |
| 68 routes with unverified role grants (C3)                                                                                                                          | CRITICAL |
| Logger redacts `*.password`/`*.token` but **not PHI fields** — only a literal `*.phi` path. A logged patient object leaks name/phone/UHID.                          | HIGH     |
| Audit anchors stored in the DB they protect — detects careless tampering, not determined tampering (documented, accepted)                                           | HIGH     |
| Uploads stored in Mongo, **no virus scan**                                                                                                                          | MEDIUM   |
| SMTP credentials are global, not per-tenant — every hospital's mail leaves via the platform's server (PROJECT_MEMORY flags this as unacceptable before white-label) | MEDIUM   |
| No CSP/security headers beyond `helmet()` defaults; no field-level PHI encryption (NFR claims it)                                                                   | MEDIUM   |
| CI has no Trivy/CodeQL/gitleaks/SBOM stage (Doc 04 §7 defers to P9)                                                                                                 | MEDIUM   |
| Access-token revocation fails **open** on Redis outage (documented, bounded by 15-min TTL, accepted)                                                                | LOW      |

### 3.7 Performance & scalability

| Concern                                                                                                  | Impact                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| OLTP aggregation for all reports; no read models                                                         | Report latency degrades with data volume         |
| E2 projection absent → each worklist is a live query                                                     | Multiplies read load per department              |
| All consumers in-process in the API                                                                      | Async work competes with p95 request latency     |
| Two demo screens fetch `listPatients({limit:100})` and join names client-side (`/reception`, `/billing`) | Wrong above ~a few thousand patients; documented |
| Documents/logos stored as bytes in MongoDB                                                               | Document growth bloats the working set           |
| `/openapi.json` cached per process; spec built on first call                                             | Negligible                                       |
| No connection-pool load validation (LRU cap 200/pod is an untested assumption)                           | Unknown at 500 tenants                           |
| No OpenTelemetry, Prometheus or Sentry — **zero production observability**                               | Cannot diagnose any of the above                 |

---

## 4. Web application audit

### 4.1 What exists

45 pages in `apps/web`, all real — no stubs, no "coming soon" placeholders. Coverage maps cleanly to
the built backend: reception, my-patients (consult + order pad + Rx pad), worklist, ward, beds,
pharmacy, billing, receipts, tariff, packages, patients + patient 360°, appointments, doctors,
theatres, ambulance, assets, feedback, mortuary, MRD, lab-catalogue, medicines, departments,
branches, reports, dashboard, audit, staff, roles, subscription, settings (profile/site/api-keys),
plus printable artefacts (OPD slip, IP sheet, discharge summary, receipts) and the full auth set
(login, MFA, forgot/reset/change password, sessions).

**A per-hospital public website exists and is properly done** — SSR at the tenant root with
`generateMetadata`, OpenGraph, published/unpublished handling, and a neutral fallback when the host
resolves to no hospital. Self-service editor at `/settings/site`.

### 4.2 Design system — good foundation, incompletely adopted

`packages/ui` holds tokens + a three-state theme (light/dark/**system**) with a pre-paint inline
script to kill the white flash. The reasoning is excellent: dark is not inverted light, semantic
colours are re-picked because a red chosen for white fails WCAG on near-black — _"in a hospital those
colours are load-bearing, not decorative."_

But **`packages/ui` ships no components.** Both apps carry their own `components/ui.tsx`
(web 688 LOC / 14 components; admin 158 LOC / 6 components) — the shared component library Doc 04 §1
specifies is duplicated, not shared. `Button`, `Badge`, `Field` and `Modal` exist twice with
different implementations.

Adoption inside `apps/web` is partial:

- `DataTable` is used by **8 of 45** pages; the rest hand-roll tables.
- `EmptyState` exists and is used by **zero** real pages (only the style guide).
- `PermissionGate` is used by 9 pages.
- 16 hardcoded `bg-gray-*` classes bypass the token system.

A live `/style-guide` page exists — a genuinely good practice.

### 4.3 UX states

| State              | Verdict                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Loading            | ✅ Broad — `Skeleton`/`Spinner` in 43/45 pages                                              |
| Error              | ✅ Broad — `ErrorAlert` + catch in 42/45; the "silent catch" lesson was learned and applied |
| Empty              | 🔴 **Weak** — the primitive is unused; empty lists mostly render as bare tables             |
| Optimistic updates | 🔴 None (no TanStack Query)                                                                 |
| Realtime           | 🔴 None — see §5                                                                            |

### 4.4 Accessibility — 🔴 the weakest frontend area

**Primitives are conscientious.** `Field` uses implicit label association, `aria-invalid`,
`aria-describedby` and `role="alert"` on errors. `Modal` has `role="dialog"`, `aria-modal`, Escape
handling and an `aria-label`led close button.

**Pages are not.** Across ~24,000 lines of page code: **59 `aria-*`, 9 `role=`, 7 `alt=`, 0
`tabIndex`, 0 `sr-only`.** `DataTable` emits `<th>` without `scope="col"`. Custom controls,
tabs and status badges carry no ARIA. There is no focus management on route change, no skip link,
and no automated a11y check in CI.

**WCAG 2.1 AA is a stated NFR (README §4). The product does not currently meet it**, and the gap is
in bespoke page markup rather than the design system — which makes it tractable: widen primitive
usage and most of it closes.

### 4.5 Responsiveness

The shell is responsive and thoughtfully so — desktop icon rail collapsing to a mobile drawer that
closes on navigation, `lg:` breakpoints throughout `AppShell`. **Page bodies are not**: across all
pages and components there are 70 `sm:`, 2 `md:`, 20 `lg:` and 0 `xl:` utilities. Dense clinical
tables (worklist, ward, beds, billing) will overflow on a tablet — the device a ward round actually
uses.

### 4.6 Architecture deviation — no feature slices

Doc 04 §3.2 mandates `apps/web/src/features/`, `src/components/`, `src/hooks/`, `src/lib/`,
`src/config/`, with pages staying thin. **`apps/web/src/` does not exist.** There are no feature
slices, no `hooks/` directory, and the documented route groups `(public)` / `(portal)` / `(app)` were
never created.

Consequence: logic lives in page files. `patients/[id]/page.tsx` is **2,407 lines**;
`my-patients/page.tsx` is **1,989**; `ward` 1,161; `staff` 984; `beds` 891. Ten pages exceed 650
lines. These are the least maintainable artefacts in the repository and the sharpest contrast with
the backend's discipline.

### 4.7 Admin console — 🟡 functional, structurally thin

**One 1,049-line `page.tsx`.** It does real work (hospital list, create-with-first-admin, suspend/
reactivate, re-price, licence + branch cap + custom domain, tenant detail drawer, renewal presets).
But Doc 04 §3.4 describes an app; this is a single file. No usage/limits dashboard, no impersonation,
no SaaS billing, no global monitoring.

---

## 5. Architecture validation

### 5.1 Followed — and enforced

| Principle                             | Status                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Modular monolith, service-extractable | ✅ 43 modules, 0 boundary violations, acyclic                                       |
| Master + DB-per-tenant (ADR-0005)     | ✅ Textbook; Connection Manager + ALS                                               |
| Configuration over code               | ✅ `organizationType` is a preset; **a test greps the source** to forbid the branch |
| Contracts (Zod → types)               | 🟡 Holds in the API; breaks at the FE boundary                                      |
| Events for side effects (ADR-0007)    | ✅ Transactional outbox, at-least-once, consumers dedupe                            |
| Reads scale by projection             | 🔴 No read models; OLTP aggregation                                                 |
| Everything auditable                  | ✅ In-transaction, append-only, hash-chained                                        |
| Clean layering                        | ✅ routes → controller → service → repository, uniformly                            |
| Repository pattern                    | ✅ Mongoose confined to repositories                                                |
| DDD-ish module boundaries             | ✅ Strong; events used to break would-be cycles                                     |
| Constitution §5 module rules          | ✅ CI-enforced                                                                      |
| Constitution §9 naming / glossary     | ✅ `encounter` not `visit`; `vendor` not `supplier`                                 |

### 5.2 Deviations

| #   | Deviation                                                                         | Authority breached               | Severity |
| --- | --------------------------------------------------------------------------------- | -------------------------------- | -------- |
| D1  | **Socket.IO never implemented** — no `realtime/`, package absent                  | ADR-0008 (Accepted), Doc 04 §2.5 | HIGH     |
| D2  | **No rate-limit or idempotency middleware** in the chain                          | Doc 04 §2.1, Constitution §7/§8  | CRITICAL |
| D3  | **Workers is a heartbeat**; all consumers in-process                              | Doc 04 §2.6 (11 queues)          | HIGH     |
| D4  | **No TanStack Query / Zustand / React Hook Form / Shadcn UI** — none installed    | Doc 04 §3.1, ADR-0004, ADR-0012  | HIGH     |
| D5  | **No `apps/web/src/` feature slices**; 2,400-line pages                           | Doc 04 §3.2, Constitution §10    | HIGH     |
| D6  | **E2 work-queue projection not built**                                            | ADR-0014 (Accepted)              | MEDIUM   |
| D7  | **OpenAPI has no schemas**; `packages/validation` a stub; api-client hand-written | Constitution §2.4/§8             | HIGH     |
| D8  | **`packages/ui` has no components**; duplicated per app                           | Doc 04 §1                        | MEDIUM   |
| D9  | **No OTel / Prometheus / Sentry**                                                 | Doc 04 §8, OBSERVABILITY_GUIDE   | HIGH     |
| D10 | **Reports aggregate over OLTP**                                                   | Constitution §2.6/§12            | MEDIUM   |
| D11 | Files in MongoDB, not MinIO (which is running in compose)                         | Doc 04 §1, ADR notes             | MEDIUM   |
| D12 | `infra/k8s/`, `infra/terraform/`, `infra/nginx/` **do not exist**                 | Doc 04 §1/§6.3                   | MEDIUM   |
| D13 | No `jobs/`, `integrations/`, `openapi/` dirs in the API                           | Doc 04 §2.2                      | LOW      |

**None of D1, D4, D6 or D9 has a superseding ADR.** ADR-0003 was correctly superseded by 0012 when
the SPA decision changed — the process exists and works, and was simply not used for these.

---

## 6. Documentation validation

The governance layer (59 docs) is **exceptional in quality and unusually honest** — PROJECT_MEMORY
in particular records not just decisions but the bugs that produced them, including one entry that
retracts an earlier claim the author had asserted without testing. That is rare and valuable.

The problem is **currency**, not quality.

### 6.1 Stale — actively misleading

| Doc                        | Last real update | Says                                                                                | Reality                                    |
| -------------------------- | ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| **README.md**              | 2026-07-17       | _"every clinical module (P2+) … it cannot yet treat a patient"_; "175 tests"        | 43 modules, full clinical loop, 1014 tests |
| **PRODUCT-TOUR.md**        | 2026-07-14       | _"No clinical screens yet"_, _"the dashboard does not exist yet"_, Steps 3–8 "next" | All of Steps 3–8 substantially built       |
| **00-PROGRESS-TRACKER §3** | —                | P3 Clinical "⬜ Not started 0%", P4 Financial "⬜ 0%", P6 Analytics "⬜ 0%"         | P3 ≈65%, P4 ≈60%, P6 ≈70%                  |
| **00-PROGRESS-TRACKER §4** | —                | E1 Appointments ⬜, F1 Billing ⬜, F4 Pharmacy ⬜, B13 Mortuary ⬜, C3/C7 ⬜        | All built and screened                     |
| **00-PROGRESS-TRACKER §7** | —                | _"Nothing is half-done. All gates green."_                                          | Gates are RED                              |
| **PROJECT_MEMORY §1**      | 2026-07-17       | "Next priorities: staff chat, E2, OpenAPI…"                                         | Three weeks and ~60 commits behind         |
| **AI_Workflow/README**     | —                | "ADRs (0001–0011)"                                                                  | 16 ADRs exist                              |

The `00-PROGRESS-TRACKER` is internally contradictory: its §4 ledger has entries dated 2026-07-28
describing modules its own §3 phase table calls "not started".

### 6.2 Implemented but undocumented

`wallet` (patient advances), `medicines` master + stock ledger, `vitals`, `reports` (file store),
`site` (public website), `hospitalProfile`, `entitlements`, `mortuary`, `mrd`, `medicolegal`,
`labCatalogue`, `consultations`, `mar`, `theatres`, `ambulance`, `assets`, `feedback` — all shipped;
none has a row in the Doc 02 module catalog reflecting its real shape. `HMS-ALLERGY-001` is thrown by
`allergy.service.ts` and is **absent from ERROR_CODES.md** (23 codes used in code, 50 documented, 1
undocumented).

### 6.3 Documented but missing

Socket.IO/realtime (ADR-0008) · E2 work queue (ADR-0014) · rate limiting · idempotency middleware ·
`packages/i18n` · mobile apps · `infra/k8s|terraform|nginx` · read models/CQRS (Doc 03 §9) ·
observability stack · specimen tracking (STATE_MACHINE_CATALOG §7, written, unimplemented) ·
`discharge_initiated` state.

### 6.4 Missing ADRs

An ADR should exist (per Constitution §6, which requires one for architecture changes) for:

1. **Deferring Socket.IO** — or superseding ADR-0008.
2. **Dropping TanStack Query / Zustand / RHF / Shadcn** — ADR-0004 and ADR-0012 both name them.
3. **Consumers running in `apps/api` rather than `apps/workers`** — decided and well-reasoned in
   PROJECT_MEMORY, but never promoted to an ADR despite being a topology decision.
4. **Storing files in MongoDB rather than S3/MinIO.**
5. **Hand-maintained api-client instead of generated** — currently debt, not a decision.
6. **Reports over OLTP instead of read models** — directly contradicts Constitution §2.6.

### 6.5 Missing diagrams / workflows

No C4 or module-dependency diagram (the dependency-cruiser graph could be emitted as one for free);
no ER diagram for 45 migrations; no sequence diagram for the outbox→relay→queue→consumer path (the
most subtle mechanism in the system); no state diagrams rendered from STATE_MACHINE_CATALOG.

---

## 7. Enterprise gap analysis

### CRITICAL — must close before any customer

| ID  | Gap                                                                                      | Area              |
| --- | ---------------------------------------------------------------------------------------- | ----------------- |
| K1  | CI has never run; 134 commits unmerged on a feature branch                               | DevEx             |
| K2  | Integration suite RED (2/1014)                                                           | DevEx             |
| K3  | 68 routes without an authorization probe                                                 | Security          |
| K4  | Payment lost-update + no payment idempotency                                             | Backend/Financial |
| K5  | No rate limiting anywhere                                                                | Security          |
| K6  | No production observability (no OTel/Prometheus/Sentry/alerting)                         | Infrastructure    |
| K7  | No backup/restore or DR procedure exercised; audit anchors stored in the DB they protect | Infrastructure    |

### HIGH

| ID  | Gap                                                                  | Area           |
| --- | -------------------------------------------------------------------- | -------------- |
| H1  | ~19 modules with zero behavioural tests (≈40% of the backend)        | Backend        |
| H2  | OpenAPI carries no schemas; api-client hand-maintained (901 methods) | Backend/DevEx  |
| H3  | No realtime — every board is stale until refresh (ADR-0008)          | Backend/UX     |
| H4  | Workers app is inert; all async work in the API process              | Infrastructure |
| H5  | Root docs describe a product three weeks behind                      | Documentation  |
| H6  | WCAG 2.1 AA not met (stated NFR)                                     | Frontend       |
| H7  | No feature slices; ten pages > 650 LOC, two > 1,900                  | Frontend       |
| H8  | PHI not redacted in logs                                             | Security       |
| H9  | No k8s/terraform/nginx; no staging; deploy path unproven             | Infrastructure |
| H10 | Custom-domain routing + TLS not built (blocks white-label sales)     | Multi-tenant   |

### MEDIUM

Reports over OLTP with no read models · E2 work-queue projection absent · files in MongoDB, no virus
scan · SMTP not per-tenant · `packages/ui` ships no components; duplicated per app · admin console is
one file, no usage/limits view · page bodies not responsive · `EmptyState` unused · no i18n despite
the NFR · no e2e/Playwright suite · missing ADRs (§6.4) · no permission-orphan test (PROJECT_MEMORY
proposes it after three incidents) · `idempotencyKeys` collection dead · CI lacks security scanning.

### LOW

16 hardcoded `bg-gray-*` · `DataTable` missing `scope="col"` · queue still wire-named
`notifications` while carrying billing · `HMS-ALLERGY-001` undocumented · MinIO ports not
loopback-bound in compose · `hms_chaintest` throwaway tenant · no SBOM.

### Readiness by dimension

| Dimension                  | Verdict                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-tenant readiness** | ✅ **Strong.** Physical isolation, host-as-selector, 17-test isolation suite, negative caching, licence gate, reserved slugs, fleet migrations. The best-executed part of the system. Gap: custom-domain TLS.                                                       |
| **Multi-branch readiness** | 🟡 Entity, active-branch header, row scope, per-branch invoice series and branch-stamped wallet all exist (ADR-0015). Untested at matrix level; the "unassigned patient" visibility question PROJECT_MEMORY flagged is still unanswered.                            |
| **Mobile readiness**       | 🟡 **Backend yes, client no.** Body-token auth, host tenancy, one typed client, MOBILE_APP_DEVELOPMENT.md scoped. But no push infrastructure, no offline sync design in code, no realtime, and the api-client is hand-written — which a third consumer will punish. |
| **Compliance readiness**   | 🟡 Audit trail is genuinely excellent. Missing: retention/archival job, off-box anchors, field-level PHI encryption, DSR/erasure endpoints, exercised DR.                                                                                                           |

---

## 8. Progress report

Percentages are _"share of a sellable v1 for a mid-size private hospital"_, with reasoning.

| Area                 | %        | Why                                                                                                                                                                                                               |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Architecture**     | **90%**  | Boundaries CI-enforced and clean; layering uniform across 43 modules; DB-enforced invariants; correct central-object model. −10 for four unrecorded stack deviations and absent read models.                      |
| **Infrastructure**   | **35%**  | Dev compose is excellent and thoughtfully hardened. Nothing exists for production: no k8s/terraform/nginx, no staging, no observability, no exercised backup/DR, workers inert.                                   |
| **Backend**          | **75%**  | 43 modules, 256 routes, 45 migrations, the whole clinical+financial loop. −25 for the payment defect, missing rate limiting, 40% of modules untested, no schema'd contract.                                       |
| **Frontend**         | **60%**  | 45 real pages covering every built module, plus a public site and printables. −40 for no feature slices, 2,400-line pages, no a11y at page level, non-responsive bodies, no realtime/optimistic updates.          |
| **Authentication**   | **95%**  | argon2id, rotating refresh with reuse detection, MFA, sessions, lockout, password history, forgot/reset, api-keys. Only SSO/passkeys (Enterprise-gated) remain.                                                   |
| **RBAC**             | **80%**  | Three-layer engine, 156 permissions, live re-derivation, self-describing middleware, 128-test matrix. **−20 because the gate is red and 68 routes are unverified** — the machinery is 95%, the _coverage_ is not. |
| **Clinical modules** | **65%**  | EMR/consultation/nursing-MAR/LIS/allergy-safety/admission/discharge all real. −35 for no RIS/PACS, OT scheduling-only, no specimen tracking, no blood bank/ED/ICU/dialysis, and a drug-safety net over 15 drugs.  |
| **Billing**          | **70%**  | Charges, invoices, payments, discounts, refunds, payer-split, packages, wallet, zero-tariff, per-branch series. **−30 for C4** (a money-correctness defect outranks feature count) and no GL.                     |
| **Laboratory**       | **75%**  | Full order→collect→result→verify→release with a two-person rule, catalogue pre-fill and auto-flagging. −25 for no specimen/accession tracking, no analyzer interface, no panels/delta checks.                     |
| **Inventory**        | **40%**  | Pharmacy stock ledger + medicine master + expiry are real. No general store, no indent/GRN/PO, no vendors.                                                                                                        |
| **Reporting**        | **70%**  | 7 substantive reports + role-aware dashboard with drill-through + CSV. −30 for OLTP aggregation, no read models, no scheduled/emailed reports.                                                                    |
| **Public website**   | **75%**  | Per-hospital SSR site with metadata/OG, self-service editor, theming, published/unpublished states. −25 for no online booking, no custom-domain routing.                                                          |
| **Admin console**    | **50%**  | Real operator capability (provision, suspend, re-price, licence, branch cap, domain). −50 for one 1,049-line file, no usage/limits dashboard, no impersonation, no SaaS billing, no monitoring.                   |
| **Mobile readiness** | **25%**  | Backend is genuinely ready and the doc is scoped. Nothing client-side; no push, no offline, no realtime, hand-written client.                                                                                     |
| **Testing & QA**     | **45%**  | 1014 tests with a falsification culture that is better than most commercial teams'. **−55: the suite is red, CI never runs, 40% of modules untested, no e2e, no a11y checks.**                                    |
| **Documentation**    | **70%**  | 59 docs of exceptional depth and honesty. −30 for severe currency drift and six missing ADRs.                                                                                                                     |
| **Security**         | **60%**  | Excellent primitives and threat reasoning. −40 for no rate limiting, 68 unverified routes, PHI in logs, no scanning in CI.                                                                                        |
| **🏁 OVERALL**       | **≈62%** | Weighted toward what a paying hospital needs. The functional surface says ~75%; the release-readiness dimensions (CI, tests, observability, deployment, money-correctness) drag it down.                          |

**Interpretation.** The _product_ is roughly three-quarters built. The _engineering system around the
product_ — the thing that makes it safe to ship, operate and change — is roughly one-third built.
That asymmetry is the story of this audit.

---

## 9. Next recommended milestone

### 🎯 Milestone: **"Green and Governed"** — restore the safety net before adding features

**Why this and not features.** The codebase has ~60 commits of unverified work sitting on a branch
that CI has never seen. Every additional feature widens that gap and makes the eventual
reconciliation harder. The project's own defences — the RBAC matrix, the isolation suite, the
falsification culture — are its best asset, and they are currently switched off. Turning them back
on is a few days of work now and a multi-week excavation in a month.

There is also a money-correctness defect (C4) on a live billing path. That alone precludes a
customer.

**Do not** start staff chat, mobile, RIS, blood bank or AI until this milestone closes.

### Roadmap, ordered by dependency

**Phase 1 — Stop the bleeding (2–3 days). Nothing else may start first.**

1. **Fix the two red tests.** Add the missing order to the encounters arrange step; add the 68 route
   probes to the RBAC matrix. _Blocks everything._
2. **While adding those 68 probes, review each grant.** This is the real deliverable — money routes
   (`discount`, `refund`, `payer-split`, `settle`) first. Expect to find at least one wrong grant;
   the codebase has a documented 3-for-3 record on this class.
3. **Merge `feature/0.1` → `main` via a PR** so CI executes. Add branch protection.
4. **Add the permission-orphan test** PROJECT_MEMORY has proposed since 2026-07-16 (fails when a
   permission is held by no `DEFAULT_ROLE`, with an explicit superadmin allow-list).

**Phase 2 — Close the critical defects (3–5 days). Depends on Phase 1.**

5. **Fix payments (C4):** add `requestId` to `recordPaymentSchema` with a unique partial index; make
   `addPayment` use `$inc` on `paid` with a guard against overpayment, or wrap read-modify-write in
   `withTransaction` with optimistic locking. Same for `addRefund`. **Write the falsifying test
   first** — two concurrent payments, assert the total — in the house style.
6. **Add rate limiting:** a Redis-backed limiter with per-route classes (auth strict, list normal,
   report generous), keyed by tenant + IP + user/API-key, returning `429` with `Retry-After`.
   Declare the class on the route so `routeInventory` can audit coverage the way it audits
   permissions.
7. **Redact PHI in logs** — extend `REDACT_PATHS` to patient identifiers and deep paths.

**Phase 3 — Restore the contract (1 week). Independent of Phase 2; can run in parallel.**

8. **Project Zod schemas into OpenAPI** (`zod-to-openapi` or equivalent) so the 216 paths carry real
   request/response bodies.
9. **Generate `packages/api-client` from that spec**, retiring 4,367 hand-written lines and the
   drift risk. This is the prerequisite for the mobile app being cheap rather than expensive.
10. **Add a CI check that the committed spec matches the shipped routes** — the same construction
    that makes the RBAC matrix trustworthy.

**Phase 4 — Make it operable (1–2 weeks).**

11. **Observability:** OpenTelemetry traces, Prometheus RED metrics, Sentry, `/metrics`. Without this
    every production incident is unresolvable.
12. **Give `apps/workers` a DB layer** and move the notification/billing/document consumers out of
    the API. Removes the latency coupling and makes Doc 04 §6.3's scaling story true.
13. **Ship audit anchors off-box** (S3 object-lock or a signed daily digest) — turns tamper
    _evidence_ into something adversarial.
14. **Exercise backup and restore** for one tenant DB against DISASTER_RECOVERY_RUNBOOK. An
    unexercised runbook is a document, not a capability.

**Phase 5 — Pay down the test and doc debt (1 week, can overlap).**

15. **Behavioural tests for the ~19 untested modules**, prioritised by blast radius: insurance
    (money), packages (money), MAR (patient safety), medicolegal (statutory), mortuary (statutory).
16. **Rewrite `README.md` and `PRODUCT-TOUR.md`** to describe the product that exists.
17. **Reconcile `00-PROGRESS-TRACKER`** §3 and §4 with reality, and refresh `PROJECT_MEMORY` §1.
18. **Write the six missing ADRs** (§6.4) — especially Socket.IO deferral and the frontend stack
    decision, so the next agent does not "restore" a library the team chose to drop.

**Only then:** the next feature milestone. On current evidence that should be **the patient portal +
online booking** (C6/G1) — it monetises the public website already built, needs no new backend
primitives, and is the natural predecessor to the mobile apps.

---

## 10. Final verdict

### 1 · Current project maturity

**Late-beta engineering on a pre-alpha delivery pipeline.** The architecture is production-grade and
would survive a rigorous external review; the module design, tenancy model and audit system are
better than much of what ships commercially in this sector. But the project is at the maturity of a
system that has never been deployed, never been observed, and — for the last three weeks of work —
never been verified by anything but a human running commands by hand.

### 2 · Production readiness

**Not production-ready. Do not onboard a paying hospital.** Blocking items, in order: the red gate
(C2), the unverified authorization surface (C3), the payment lost-update (C4), absent rate limiting
(C5), and zero observability (K6). Estimated **4–6 focused weeks** to a defensible pilot with one
design partner — and the first two weeks of that are cleanup, not features.

The good news: none of the blockers is architectural. They are all things the design already
anticipated and the delivery simply outran.

### 3 · Biggest strengths

1. **Invariants enforced by the database, not by hope.** Six unique partial indexes doing work that
   most systems attempt in application code and lose to a race.
2. **Tenant isolation as a physical property**, with two independent factors (host + token) and a
   17-test suite that fails rather than skips.
3. **Boundary discipline that is actually enforced** — 0 violations across 537 modules, with the
   rule having _improved_ designs rather than obstructed them.
4. **A falsification culture.** Tests are trusted only after being watched go red for the right
   reason. The RBAC matrix reads the shipped app rather than a hand-written list. This is genuinely
   rare and is why the codebase has so few latent bugs.
5. **Institutional memory of exceptional quality.** PROJECT_MEMORY explains _why_, records the bugs
   that taught each lesson, and retracts its own untested claims. It is the reason this audit could
   be thorough.
6. **One code path for private and government hospitals**, with a test that greps the source to
   forbid the `organizationType` branch. The `listPrice`/`amount` split is a genuinely sophisticated
   piece of domain modelling.
7. **Clinical safety reasoning** — the severity ladder, the two-person verification rule, "a missing
   tariff never blocks care", "billing listens; nothing clinical depends on it".

### 4 · Biggest risks

1. **The safety net is off.** CI has never run; the gate is red; 68 routes unverified. Every day this
   persists, the cost of reconciliation compounds.
2. **A money-correctness defect on a live path (C4)** — the failure mode is a patient charged twice
   or a hospital's day-end not reconciling, which is precisely the thing that destroys trust in HIS
   software.
3. **Zero production observability.** The first production incident would be undiagnosable.
4. **Unrecorded architectural drift.** Four documented, ADR-backed decisions (Socket.IO, TanStack,
   Zustand, RHF/Shadcn) were silently dropped. The next agent will read the ADRs, believe them, and
   either rebuild against a phantom or "restore" something deliberately abandoned.
5. **Frontend maintainability.** A 2,407-line page is where the next hard bug will hide, and the
   contrast with the backend's discipline suggests the frontend was built under different pressure.
6. **40% of the backend is untested**, concentrated in the newest modules — including insurance and
   packages, which move money.
7. **Documentation drift misleads the next contributor**, which for an explicitly AI-first project is
   a first-order risk, not a housekeeping one.
8. **Single-contributor bus factor** — 135 commits, one author.

### 5 · Top 20 recommendations

| #   | Recommendation                                                                                                                     | Sev      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Fix the 2 failing tests; add the 68 RBAC probes, reviewing each grant as you go                                                    | CRITICAL |
| 2   | Merge to `main` via PR so CI runs; enable branch protection                                                                        | CRITICAL |
| 3   | Fix the payment lost-update — `$inc` or optimistic lock — with a falsifying concurrency test first                                 | CRITICAL |
| 4   | Add `requestId` idempotency to payments, refunds and discounts                                                                     | CRITICAL |
| 5   | Implement Redis-backed rate limiting with per-route classes, audited by `routeInventory`                                           | CRITICAL |
| 6   | Add the permission-orphan test (a permission no role holds)                                                                        | HIGH     |
| 7   | Ship OpenTelemetry + Prometheus + Sentry before any pilot                                                                          | HIGH     |
| 8   | Redact PHI in logger paths                                                                                                         | HIGH     |
| 9   | Project Zod into OpenAPI; **generate** the api-client; CI-check spec vs routes                                                     | HIGH     |
| 10  | Behavioural tests for the ~19 untested modules, money and safety first                                                             | HIGH     |
| 11  | Give `apps/workers` a DB layer; move consumers out of the API process                                                              | HIGH     |
| 12  | Rewrite `README.md` + `PRODUCT-TOUR.md`; reconcile `00-PROGRESS-TRACKER` §3/§4                                                     | HIGH     |
| 13  | Write the six missing ADRs — Socket.IO and the frontend stack above all                                                            | HIGH     |
| 14  | Ship audit anchors off-box; exercise a tenant backup/restore                                                                       | HIGH     |
| 15  | Extract `apps/web/src/features/`; break up the 10 pages over 650 LOC                                                               | HIGH     |
| 16  | Move design-system components into `packages/ui`; delete the duplicates                                                            | MEDIUM   |
| 17  | Close the a11y gap: adopt primitives everywhere, add `scope="col"`, focus management, skip link, and an automated a11y check in CI | MEDIUM   |
| 18  | Add Trivy/CodeQL/gitleaks/SBOM to CI and a Playwright smoke suite for the clinical loop                                            | MEDIUM   |
| 19  | Build read models for reports/dashboard before the first large tenant                                                              | MEDIUM   |
| 20  | Make SMTP per-tenant and move files to MinIO before white-label sales                                                              | MEDIUM   |

### 6 · Best next milestone

**"Green and Governed"** (§9) — a 2–3 week hardening milestone that restores the release gate, closes
the five critical defects, regenerates the API contract, and makes the system observable. Ship it
before any new feature.

**Rationale.** This project's defining strength is that its safeguards are _constructive_ — the RBAC
matrix reads the real app, the isolation suite refuses to skip, the tests are proven by
falsification. Those safeguards are currently disabled, and 60 commits of work have accumulated
behind them. Every feature added now is a feature added blind. Two to three weeks spent turning the
net back on will be repaid within the first month, and it is the only path by which the _next_
milestone — the patient portal, then mobile — can be delivered with the confidence the rest of this
codebase has earned.

---

## How to re-audit

```bash
ls apps/api/src/modules | wc -l                                   # backend modules
grep -c 'v1Router.use(' apps/api/src/app.ts                       # wired routers
grep -rhoE 'router\.(get|post|put|patch|delete)\(' apps/api/src/modules/*/*.routes.ts | wc -l
find apps/web/app -name page.tsx | wc -l                          # web pages
grep -cE 'id: "[0-9]{4}' apps/api/src/core/db/migrations/tenantMigrations.ts

pnpm typecheck && pnpm lint && pnpm boundaries && pnpm test       # fast gates
pnpm docker:dev && pnpm --filter @medicore/api test:int           # RELEASE GATE — must be green
pnpm --filter @medicore/api routes                                # the real authorization surface
git log --oneline main..HEAD | wc -l                              # unmerged, unverified work
```

**The last two commands are the ones that matter.** This audit exists because nobody ran them.
