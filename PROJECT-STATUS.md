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

## API contract Phase 2 — response contracts (2026-08-11) · CLOSED

The remaining half of the contract. 265 operations described what a client could SEND and nothing
described what it would RECEIVE, which is how the api-client's hand-written types had drifted from
the server on 37 fields without anyone noticing. **Full gate green, 1,409/1,409 integration,
23 new contract tests, every control falsified.**

|                                 | Before | After                                |
| ------------------------------- | -----: | ------------------------------------ |
| Operations                      |    265 | 265                                  |
| **JSON success responses**      |  **0** | **260**                              |
| Non-JSON responses documented   |      0 | 5 (four downloads + the spec itself) |
| Undocumented responses          |    265 | **0**                                |
| Named response components       |      0 | 165                                  |
| Client response types verified  |      0 | 126, field by field                  |
| Client/server response mismatch |     37 | **0**                                |

### The mechanism: the application is the source of truth, and tsc enforces it

A contract is a Zod schema of the WIRE shape, tied to the DTO its service returns by
`Proves<Matches<schema, Dto>>` — mutual assignability over normalised shapes. Add a field to
`Patient` and the build fails until the schema follows. `Wire<T>` applies the one transformation
the envelope performs (`Date` → ISO string), so the DTOs keep the types the server works with;
changing them to strings would have been a wide behavioural refactor of date handling for a
cosmetic gain.

**Plain mutual assignability was not enough, and falsifying the first contract is what showed it.**
Inventing a field failed the build; removing an OPTIONAL one did not — an absent optional property
is assignable to a present one in both directions. `branchId?` is exactly that class of field. Both
sides are now normalised with `-?` plus a tuple wrapper, so a missing property is a hard mismatch.

`responds()` declares the payload in the route chain beside `validate()`, and outside production it
also VERIFIES: `ok()` parses the JSON it is about to send. The existing integration suite became a
contract conformance suite at no cost — 1,409 tests already exercise these endpoints with real
data, and every one now also asserts the response is the shape the spec promises.

### Defects found — three of them live, none by inspection

- **Prescription lines were serialized as Mongoose internals.** `toPrescription` spread the line
  subdocument, which is correct for a `.lean()` read and wrong for the hydrated document `create()`
  returns. `POST /prescriptions` answered with `{ __parentArray, __index, $__parent: {…} }`: the
  drug code and dose were absent, and **`$__parent` carried the entire raw document, `tenantId`
  included, back to the caller**. One path out of eight, and no test looked at that path's lines.
- **Every dispense shipped `creditOverride: {}`.** Declared as a nested path group rather than a
  subdocument, so Mongoose materializes it on every hydrated read — an empty object where the type
  promises a complete authorisation record or nothing. A `.lean()` read of the same dispense
  omitted the key, so the two paths disagreed about the shape as well.
- **`getRole` was typed `Role`**, which has no permission codes — the role editor could not read
  the permissions it exists to edit. Now `RoleDetail`.
- **`NotificationRecord.branchId` was a field the client promised and the server never sent.**
  Notifications have stored a branchId since Phase 1; the read DTO dropped it. The server now
  projects it.
- **Two `Promise<unknown>` annotations** in the platform service (`setHospitalPlan`, `getHospital`).
  An `unknown` return is not imprecision — it makes the operation's response impossible to state.
- **36 fields the client never declared**: `Encounter.history`, `Order.createdAt`/`requestId`,
  `Invoice.episodeId`/`version`, `Dispense.creditOverride`, `Session.expiresAt`,
  `StaffMember.lockedUntil`, `UsageLine.warning`/`exceeded`, `Appointment.statusHistory` …

### The baseline moved, deliberately

51 operations lost their documented `200`. The old spec claimed 200 on every operation as a
placeholder; those 51 are creates that have always answered 201. **No server behaviour changed and
no working client can be affected** — a client trusting that 200 was already wrong. The runtime
status check, green across all 1,409 tests, is what establishes these routes never send 200.

### Falsification

| Control              | Broken by                                                           | Result  |
| -------------------- | ------------------------------------------------------------------- | ------- |
| `Proves<Matches<>>`  | removed optional field · required→optional · wrong type · extra     | 🔴 all  |
| runtime `ok()` check | a repository silently stops populating `Branch.code`                | 🔴      |
| `client:check`       | dropped a response field · required→optional · invented a field     | 🔴 all  |
| contract tests       | removed `branchId` from a contract · client loses `Invoice.version` | 🔴 both |

### Deliberately not done

- **The client is not generated.** The spec could now support it, but the risk being managed was
  never "hand-written", it was "unchecked" — and the client carries real runtime behaviour (silent
  refresh, tenant host, active branch, licence headers, injected fetch) a generator would have to
  reproduce rather than replace. Generation is now a decision on its own merits, not a rescue.
- 36 small contracts (acknowledgements like `{ removed: true }`, and nested pieces) have no named
  client type; the client models them inline at the method, which is the right shape for them. The
  gate enforces a named type only for top-level responses of four fields or more.

## API contract stabilization (2026-08-11) · CLOSED

The Constitution §4 says "Zod schemas → types → OpenAPI: one source of truth." That pipeline did
not exist. Three sources described the API and no arrow connected them: 200 Zod schemas validated
at runtime and reached nothing; a 216-path spec was generated from routes alone; a 4,378-line
client was typed by hand. **Full gate green, `PNPM_GATE_EXIT=0`, 1409/1409 integration, four new
controls all falsified.**

### The contract pipeline, before and after

|                                    |         Before |                       After |
| ---------------------------------- | -------------: | --------------------------: |
| Paths / operations                 |      216 / 265 |                   216 / 265 |
| **Documented request bodies**      |          **0** |                     **125** |
| Operations with typed query params |              0 |                          42 |
| Operations with typed path params  |              0 |                         127 |
| Documented 400 responses           |              0 |                         228 |
| Success response schemas           |              0 | **260** (see Phase 2 below) |
| Error schemas                      | 1 (`ApiError`) |              1 (`ApiError`) |
| Spec size                          |         245 KB |                      509 KB |

`validate()` now tags itself with its Zod schema, exactly as the auth factories tag the permission
they enforce, and the spec reads it back off Express's own router stack. **There is no second list
to forget** — the documented request shape is the shape that runs.

### Why success responses were left undescribed here

There was not one response Zod schema in the codebase; the repository DTOs were TypeScript
interfaces. Emitting `{ success, data: object }` would have documented the envelope, said nothing
about the payload, generated a useless `unknown`, and claimed coverage the API did not have. **The
contract describes reality, including the part of it that is missing.** Closed by Phase 2 below.

### Four new gates, each falsified

| Gate             | Proves                                        | Falsified by                                                                  |
| ---------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `openapi:check`  | the spec matches the shipped routes           | renaming a route ✅ · adding a Zod field ✅                                   |
| `contract:check` | evolution stays additive                      | new required field ✅ · removed field ✅ · narrowed enum ✅ · removed path ✅ |
| `client:check`   | every operation is reachable and branch-aware | deleting a method ✅ · dropping `branchId` ✅                                 |
| determinism      | generate → format → generate is a fixed point | verified over three runs, byte-identical                                      |

Breaking changes are compared against `openapi.baseline.json` — the last _approved_ contract. A
break is impossible by accident and one command on purpose (`contract:accept`), which is what Doc
04 §5.1's additive-only policy needs to be real rather than aspirational.

### Defects found and fixed

- **The formatting oscillation.** The generator wrote `JSON.stringify`, Prettier reformatted it,
  and `openapi.json` was not ignored — so every regeneration produced 829 lines of churn and
  `format:check` failed on freshly generated output. That is why the spec sat un-regenerated for
  two weeks, and why a real contract change would have hidden inside the noise. The documented
  standard "OpenAPI regenerated on every merge (CI)" was _impossible_ until this was fixed.
- **15 branchId contract mismatches.** The audit estimated seven from the models; comparing
  response DTOs against client interfaces found **eight, and a different eight** — three of the
  estimate were false and four were missed. Plus six request-side gaps. `setDoctorSchedule` is the
  sharp one: Phase 1 made schedules branch-scoped and Phase 1.5 proved it, and **the web app could
  not reach the feature through its own typed client**.
- **39 `ok()` helpers had drifted into 4 signatures**, one taking `meta` where the others took an
  HTTP status. Each copy was locally consistent, so the mismatch existed only _between_ files.
- **26 unreachable operations** (not the ~40 estimated — the estimate miscounted `paged()` list
  endpoints). All now typed; 260/265 reachable, 5 exempt by policy with stated reasons.
- **Two more request gaps found by the checker itself**: `createHospital` accepted
  `organizationType` and `adminPassword` server-side and offered neither.

### Client surface

|                      |              Before |                 After |
| -------------------- | ------------------: | --------------------: |
| Interfaces           |                 145 |                   155 |
| Methods              |                 242 |                   266 |
| Lines                |               4,378 |                 4,677 |
| Operations reachable | ~223 (unverifiable) | **260/265, enforced** |
| branchId mismatches  |                  15 |       **0, enforced** |

The surface **grew**, and that is the honest outcome: generation is not yet possible without
response schemas, so the duplication was _verified_ rather than eliminated. The risk was never
"the types are hand-written" — it was "nothing checks them", which is how eight response types
quietly lost a field. A verified hand-written type is as safe as a generated one.

The runtime is untouched: auth, silent refresh, tenant host, `X-Active-Branch`, licence headers,
`ApiClientError`, `fetchImpl`. **Zero node builtins, zero browser globals** (the two greps that
match are comments) — React Native ready as `MOBILE_APP_DEVELOPMENT.md` assumes.

### Remaining API risks

- **No success response schemas** — the blocker for generating the client and for typing `data`.
- **Versioning is a mount path, not a contract.** No version constants, no `Deprecation`/`Sunset`
  headers, no API-key version pinning. Deferred deliberately: `/v1` had to become stable first.
- **`Idempotency-Key` is unimplemented.** `idempotencyKeys` exists from migration 0004 and nothing
  writes it; orders carry a one-off `requestId` instead. Deferred until after the contract.
- **Request-shape conformance is name-based** — it catches a field disappearing from the client
  entirely, not a field on the wrong method. Response DTOs would make it exact.

---

## Multi-branch Phase 1.5 — the branch survives what is not a request (2026-08-11) · CLOSED

Phase 1 left six collections `branchId`-optional because they are written by consumers off an
event payload, and enforcing before the chain was proven would wedge the outbox rather than
surface a bug. Phase 1.5 proved the chain. **46 tests in the branch suite, six controls falsified,
1409/1409 integration.**

### Event branch propagation — audited end to end

`operation → publish → outboxEvents → envelope → handler → target write`

The channel was already sound: the outbox row carries `branchId`, `outboxRelay.dispatch` copies it
into the envelope, and `markRetryOrFail` only `$set`s status/availableAt/lastError — so a retry
cannot erase it. **The gaps were at the two ends.**

| Gap                                                                     | Effect                                                                                                                                             | Fix                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| The consumer bound tenant, trace and connection — **but no branch**     | inside a handler `writeBranchId()` had nothing to resolve; for a multi-branch hospital it would throw HMS-BRANCH-001 and wedge the outbox on retry | `eventConsumer.withTenant` binds `activeBranchId` from the envelope |
| `notify()` left `branchId` to each caller, and callers disagreed        | `order.result.released` and `password.reset` recorded no site                                                                                      | derived once in `notify`, explicit argument still wins              |
| `appointment.cancelled` and `encounter.closed` published with no branch | billing closes the bill off `encounter.closed` — an invoice that cannot say which site raised it                                                   | publish from the record's own branch                                |

Binding the branch in the consumer is the point: it fixes `order.result.released` **and every
handler nobody has written yet**, at the same choke point a request uses, with no per-consumer
plumbing. Per-consumer plumbing is what produced the split in the first place — billing, medicines,
patients and prescriptions each remembered `event.branchId`; the rest did not.

`patients.merged`, the three identity events and the two subscription events are branchless **on
purpose**: they are tenant-level facts, and a branch on them would be a fiction.

### Doctor leave — what the model can and cannot say

|                                            | Representable?             |                                                                                                                                                                                    |
| ------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Branch-specific** — away at this site | **Yes**, and correct today | proven by test, both directions                                                                                                                                                    |
| **B. Hospital-wide** — away everywhere     | **No**                     | `scopeFilter` matches `branchId` exactly, so a row left branchless to mean "everywhere" is invisible to everyone who has selected a site. It would suppress **nothing**, silently. |

**Not implemented**, per instruction — nothing in the product asks for it, and a wrong guess books
patients with a doctor who is not in the building. Today two branch-specific rows express it.

**The smallest change, when it is wanted:** an explicit `scope: "branch" | "hospital"` field on
`doctorLeave`, plus a leave-specific filter (`branchId ∈ allowed OR scope === "hospital"`) in
`findLeave`/`isOnLeave` instead of the generic `scopeFilter`. It must be a stored intent, not an
absent `branchId` — the P2 lesson: when emptiness is load-bearing, store the intent.

### Final branchless audit — attribution exhausted

| Tenant                      | Branches | Branchless | Attributable | Preserved |
| --------------------------- | -------- | ---------- | ------------ | --------- |
| apollo · district · harmony | 1 each   | **0**      | —            | —         |
| sunrise                     | 2        | 38         | **0**        | 38        |

Every remaining row was chased to its parent and the parent could not answer:

| Collection      | n   | Why it cannot be attributed                                                                                        |
| --------------- | --- | ------------------------------------------------------------------------------------------------------------------ |
| notifications   | 18  | 17 carry an `eventId` and all 17 outbox rows still exist — **none has a branch**; they predate the propagation fix |
| stockMovements  | 15  | all `receipt`, written through the HTTP path that never captured a branch; no `dispenseId`, no parent              |
| walletEntries   | 3   | deposit/refund/deposit, no invoice and no encounter — cash at a desk, and which desk was never recorded            |
| doctorSchedules | 2   | pre-branch templates; nothing distinguishes the sites                                                              |

Not fabricated. Reported on every `migrate --all`.

### Schema regression guard

`tenantScopePlugin` eating a model's `branchId` is now a test, asserted on the **real compiled
models** through their accessors — a plugin unit test would pass against a plugin that is right in
isolation and a model that applies it in the wrong order. Both halves are pinned: required stays
required on the branch-scoped six, and optional stays optional on Patient and Allergy.

### Falsification — six controls, all red

consumer branch binding **1** · `publish` drops the branch **2** · retry erases it **1** · plugin
overwrites `branchId` again **1** · schedules not narrowed by branch **1** · leave lookup ignores
branch scope **1**

### Remaining risks

- **Six collections stay `branchId`-optional** — charges, invoices, notifications, dispenses,
  walletEntries, stockMovements. The propagation is now proven, so this is no longer blocked on
  evidence; it is blocked on the 38 historical rows above, which would fail validation on any
  update. Enforcing is a data decision now, not an engineering one.
- **Hospital-wide leave does not exist** (above).
- **Stock levels remain tenant-wide** — the formulary carries one balance, so per-branch stock is
  not modelled. Movements record the site; the balance does not.
- The intermittent RBAC infrastructure timeout recurred once during the gate (1 of 1409, a 20 s
  timeout on a matrix row, passes standalone at 1.7 s). Container memory pressure. **Unchanged and
  not worked around.**

---

## Multi-branch Phase 1 — make the data fit the boundary (2026-08-11) · CLOSED

Phase 0 proved a Branch-A user cannot reach Branch B. Phase 1 is the other half: that a hospital's
data can actually **live** inside that boundary. **18 new tests (35 in the suite), full gate green,
six controls falsified.**

### What it found

| Finding                                                                                                               | Severity     | Status                      |
| --------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------- |
| Three more request-body branch bypasses — `PUT /doctors/schedule`, `PUT /doctors/availability`, `POST /doctors/leave` | 🔴 security  | Fixed — HMS-AUTH-005        |
| `tenantScopePlugin` silently overwrote all 29 models' `branchId`, so `required: true` enforced **nothing**            | 🔴 latent    | Fixed                       |
| Console-provisioned hospitals had **no branch at all** → every row branchless, silently                               | 🔴 data      | Fixed at `provisionTenant`  |
| Every HTTP stock receipt/adjustment written branchless (the `branchId` argument no caller passed)                     | 🟠 data      | Fixed                       |
| A doctor's second-site Monday **overwrote** the first through the upsert key                                          | 🟠 data loss | Fixed — migration 0046      |
| Two branches could not both have an ICU                                                                               | 🟠 blocker   | Fixed — migration 0046      |
| The Main-Branch backfill would adopt unattributable rows on a multi-branch tenant                                     | 🟠 integrity | Fixed — refuses and reports |

The three roster bypasses are the **same class** Phase 0 closed and the grep missed them: they do
not use the `input.branchId ?? (await writeBranchId())` idiom, they pass the body value straight
down. Roster writes, not patient writes, which is why nothing clinical pointed at them.

### Falsification — six controls broken on purpose, all went red

| Control broken                            | Red |
| ----------------------------------------- | --- |
| Roster branch validation (trust the body) | 7   |
| Ward index left tenant-wide               | 1   |
| Occupancy index left tenant-wide          | 2   |
| Console provisioning seeds no Main Branch | 2   |
| Backfill guard removed                    | 1   |
| Stock movement branch stamping removed    | 1   |

### Migrations

- **0046** — `one_ward_name_per_branch`, `one_open_stay_per_bed_per_branch`, and branch-aware
  schedule/roster keys. Every change **widens** a unique key, so it cannot fail on existing data.
  Created before the old index is dropped, so an interruption leaves the stricter key, never a gap.
- **0047** — derives a branchless ledger row's branch **from its parent** (wallet entry → invoice or
  encounter; stock movement → dispense). A lookup, not a guess.

Applied to all four local tenants; re-run is a clean no-op.

### Branchless audit, after remediation

| Tenant                    | Branches | Result                           |
| ------------------------- | -------- | -------------------------------- |
| apollo, district, harmony | 1 each   | **zero branchless rows**         |
| sunrise                   | 2        | 38 rows left alone, deliberately |

Sunrise's remainder is 3 wallet deposits/refunds with no invoice, 15 stock receipts/adjustments
written before the stamping fix, 2 pre-branch doctor schedules, and 18 notifications. **None can be
attributed without inventing a site**, so none was. They are reported on every `migrate --all`.

### `branchId` now required on

encounters · appointments · orders · prescriptions · wards · rooms · beds · doctorSchedules ·
doctorAvailability

Still optional, each for a reason: patients and allergies (hybrid identity / safety exception), the
tenant-wide set, and the event-driven writers — charges, invoices, notifications, dispenses,
walletEntries, stockMovements — which take their branch off an event payload. Failing those closed
before every publisher is proven to propagate `branchId` would wedge the outbox on a retry loop
rather than surface a bug. **That is the next piece of work.**

### Remaining risks

- **Doctor leave is branch-filtered on read** (`scopeFilter`), so leave recorded at one site does not
  suppress slots at another. Fail-open on an absence. Pre-existing; not changed here.
- **Stock levels are tenant-wide.** The formulary carries one balance, so per-branch stock is not
  modelled. Movements now record the site; the balance does not. A real feature, not a defect.
- The intermittent RBAC timeout persists under local container memory pressure (1 of 1398, passes
  standalone). Unrelated to branches — see the Docker OOM note.

---

## Multi-branch Phase 0 — prove the isolation (2026-08-11) · CLOSED

ADR-0015 shipped multi-branch complete and **untested**: 1363 integration tests, not one of which
ever sent `X-Active-Branch`. Phase 0 was to prove the control rather than rebuild the architecture.
New suite `branchIsolation.int.test.ts` — **17 tests, all green, all four controls falsified.**

### 🔴 It found a real vulnerability, on the vector nobody had tried

Five services took the branch straight from the request body:

```ts
const branchId = input.branchId ?? (await writeBranchId()); // patients, encounters,
// appointments, orders, mrd
```

`input.branchId` is client-supplied and **nothing validated it**, so it bypassed the very choke
point ADR-0015 names as the only way a branch is ever written. **A receptionist confined to
Hyderabad could `POST /patients` with Chennai's id in the payload and the row was created in
Chennai** — a site she cannot read, write, or see in her switcher.

The other three vectors were already sound: the header is validated against the live allowed set,
the query string is refused by a `.strict()` schema, and the URL carries no branch. The body was
the one nobody had tried, which is exactly why it was open.

**Fixed at the choke point**, not per-service: `writeBranchId(requested?)` now validates a
caller-supplied branch via `assertWritableBranch` and refuses with **HMS-AUTH-005** when it is
outside the caller's allowed set. It refuses where the header merely ignores, because a `branchId`
in a mutation body is an explicit instruction, not stale UI state.

### Falsification — all four controls broken on purpose, each went red for its own reason

| Control broken                       | Result                                                    |
| ------------------------------------ | --------------------------------------------------------- |
| Header validation (trust the header) | **3 red** — "receptionist A reached the Chennai patient"  |
| Branch read filter (drop the `$in`)  | **5 red** — including cross-branch read by id             |
| Write stamping (never stamp)         | **4 red** — rows lose their site, All-mode lists go empty |
| All-mode refusal (guess a branch)    | **2 red** — HMS-BRANCH-001 never raised                   |

`authorize.ts` was verified byte-identical to HEAD afterwards.

### Ward and doctor-schedule findings (your decisions 3 and 4)

Both entities are branch-aware in the **document** and branch-blind in the **unique index**:

- **`one_ward_name_per_tenant`** on `{tenantId, name}` — Branch A "ICU" and Branch B "ICU" cannot
  coexist today; the second is rejected. It is deliberately coupled to `one_open_stay_per_bed` on
  `{tenantId, bed.ward, bed.bedCode}` (migration 0020, no branch), so **both must move together**
  or bed occupancy breaks. Live data: **0 wards**, so the migration is currently free.
- **`doctorSchedules {tenantId, doctorId, weekday}` unique** — described in the migration as "the
  upsert key", so a doctor can hold exactly **one template per weekday tenant-wide**. Monday
  morning in Hyderabad and Monday afternoon in Chennai is impossible: the second upsert overwrites
  the first. Live data: **2 schedules**, so this migration is free too.

### Branchless-row audit (read-only, all four tenant databases)

Operational collections are **fully stamped** — patients, encounters, appointments, orders,
prescriptions, invoices, charges, dispenses all show `branchless=0`. Two exceptions:

| Collection       | Branchless rows              | Reads branch-filtered? |
| ---------------- | ---------------------------- | ---------------------- |
| `stockMovements` | 15 (district) + 16 (sunrise) | No                     |
| `walletEntries`  | 4 (sunrise)                  | No                     |

Neither is currently invisible, because neither repository branch-filters — but both become
invisible the moment they do, and both block making `branchId` required.

### 🔴 The Main Branch is not seeded on the console path

`seedMainBranch` is called by the **CLI** (`scripts/provisionTenant.ts`, `migrateTenants.ts`) and
**never** by `platform.service.ts createHospital` — the admin-console path. A hospital provisioned
through the console therefore has **no Main Branch at all**: `writeBranchId()` finds zero candidates
and every operational write is branchless. That file's own comment warns about this exact trap
("provision now, seed later, and the second step is forgotten") for notification templates and
tariff; branches are the third instance. **One line, and it blocks migration readiness.**

### Entity classification — `branchId` written but reads not branch-filtered

| Module                                                                    | Verdict                                                                                             |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `allergies`                                                               | ✅ Correct and documented — an allergy must cross branches or the safety check sees an empty list   |
| `branches`, `rbac`, `entitlements`                                        | ✅ Correct — the binding/config itself, not a scoped row                                            |
| `vitals`, `wallet`                                                        | 🟡 Parent-keyed (encounter / patient), so probably correct — but **undocumented**, unlike allergies |
| `medicines` / `stockMovements`, `pharmacy` / `dispenses`, `notifications` | ⬜ **Undecided** — needs a classification decision                                                  |

---

## Phase 1A — hardening (2026-08-10) · CLOSED

The audit below is preserved as written. This block records what has since changed, so the two are
never confused: **everything under §2 CRITICAL was found by that audit; four of the five are now
fixed.** Commits `e81d8ea` · `ca5386e` · `dfa2685` · `fb49561` · `022dafd` · `327f0c2`.

| Audit finding                              | State                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| C2 · release gate RED (2 failures)         | ✅ **Green — 1363/1363, 12/12 files** (was 1012 passed / 2 failed)                         |
| C3 · 68 routes with no authorization probe | ✅ Probed. None was unprotected; all 340 derived assertions pass. Grants reviewed.         |
| C4 · payment lost-update                   | ✅ Fixed in the database, plus idempotency keys. Falsified.                                |
| H8 · PHI not redacted in logs              | ✅ Fixed at the logger choke point + the access log. Falsified.                            |
| C1 · CI has never run                      | 🟡 Workflow fixed and verified locally; **execution blocked off-repo** — see next section. |
| C5 · no rate limiting                      | ⬜ Still open — Phase 2.                                                                   |
| K6 · no observability                      | ⬜ Still open — Phase 3.                                                                   |

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

## CI validation (2026-08-11) · workflow FIXED · execution BLOCKED off-repo

Commits `a2a4177` · `58632a5`.

### The root cause of C1 is not in this repository

The audit was right that CI has never run and wrong about why. It reasoned "there is no PR"; in
fact **PR #1 existed and was merged on 2026-07-17**, and the Actions history holds three runs. All
three failed **before their first step**, with the same annotation:

> The job was not started because your account is locked due to a billing issue.

Re-confirmed empirically on 2026-08-11 by re-triggering run `29599403771`: rejected in **8
seconds**, same annotation. The repository is public, so free minutes are not the constraint — the
**account** is locked, and the remedy is on GitHub's billing settings, outside this repository. No
workflow change can affect it. (`main` was later reset to the initial commit; the merge commit for
PR #1 is unreachable from any ref today.)

### What was wrong with the workflow itself

Unrun code accumulates the defects of unrun code. Two would each have failed the job on its first
real execution, and one was a security hole:

| Defect                                                                                         | Consequence                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm/action-setup` given `version: 10` while package.json pins `packageManager: pnpm@10.34.5` | **Job dies at setup.** The action compares the two literally and throws on any difference — and `10` differs from `10.34.5`. |
| PR title interpolated into a shell command                                                     | **Remote code execution on the runner** by anyone who can open a PR — this repository is public.                             |
| `pnpm-lock.yaml` is committed Prettier-formatted; pnpm writes its own style                    | The **first dependency change after CI works** renormalises ~4000 lines and fails `format:check` on a diff nobody wrote.     |
| `timeout-minutes: 20` set without measurement                                                  | Measured: ~5 min of compute on a 10-core machine, of which integration is 3.5. A runner has 4 vCPU. Raised to 30.            |
| `cancel-in-progress` applied to `main`                                                         | Superseding a run on `main` leaves a commit that is supposed to be deployable with no verdict. Now PR-only.                  |
| No `permissions:` block                                                                        | Default token is writable; nothing here writes. Now `contents: read`.                                                        |
| `mailhog/mailhog:latest`                                                                       | Mailhog is archived upstream, so `:latest` can only move or vanish. Pinned to `v1.0.1`.                                      |

Added, because a pipeline nobody can read is a pipeline nobody fixes: a **preflight** that names
which service is unreachable rather than letting a suite fail obscurely five minutes later, a
**capacity line** on every run so "did we run out of memory?" is answerable from the log, a
**failure-only diagnostics dump** (containers, mongod log, memory, disk), and `workflow_dispatch`
so the gate can be asked for on demand.

### Verified locally, since CI cannot verify itself

Against a **clean `git clone` with no `.env` files**, on CI's exact infrastructure shape — `mongo:7`
single-node replica set on 27017, `redis:7-alpine` on 6379, Mailhog — proving the pipeline depends
on no developer-local configuration:

| Check                                  | Result                             |
| -------------------------------------- | ---------------------------------- |
| `pnpm install --frozen-lockfile`       | ✅ lockfile in sync                |
| `pnpm format:check`                    | ✅                                 |
| `pnpm lint`                            | ✅ 17/17                           |
| `pnpm typecheck`                       | ✅ 17/17                           |
| `pnpm test` (unit)                     | ✅ 55 (logger 13, utils 5, api 37) |
| `pnpm --filter @medicore/api test:int` | ✅ **1363/1363, 12/12 files**      |
| `pnpm build`                           | ✅ 11/11 tasks                     |
| `pnpm boundaries`                      | ✅ 0 violations                    |

Confirmed the CI-shaped Mongo really served that run (845 log lines naming `test_*` databases) and
that Redis carried the per-suite logical databases `db1`–`db11`, so the pass is not an artefact of
the harness quietly falling back to the dev containers on 37018/6380.

Then repeated on **CI's platform rather than the developer's** — Linux, Node **22.23.2** (from
`.nvmrc`), pnpm **10.34.5** (resolved from `packageManager` via corepack), where local development
runs Node 26 on macOS:

- `pnpm install --frozen-lockfile` on **linux/amd64** ✅ — the check that matters most, because it
  proves the lockfile carries Linux-x64 native binaries (`@node-rs/argon2`, `sharp`,
  `msgpackr-extract`). A macOS-only lockfile is a classic first-CI-run failure.
- format · lint · typecheck · unit (55) · build · boundaries on **linux/amd64, Node 22** ✅
- The workflow's preflight script, run verbatim inside a container whose services share one network
  namespace — the runner's "everything on 127.0.0.1" topology ✅

### 🔴 What running on a UTC machine revealed — a genuine product defect

The first run of the gate on a **UTC** machine — which is what every CI runner and every container
is, and what no developer here has been — failed one test out of 1363:

```
notifications › "renders the time in the hospital's timezone, not UTC"
AssertionError: expected 'Dear Meera Nair…' to match /09:15\s*(am|AM)/
```

Tracing it found something larger than the test. **Two modules resolve time in two different
zones:**

| Module                     | How it resolves time                                        |
| -------------------------- | ----------------------------------------------------------- |
| `appointment.service.ts`   | `startAt.getDay()` + slot arithmetic → the **process** zone |
| `appointment.consumers.ts` | `Intl` with `env.DEFAULT_TIMEZONE` → **Asia/Kolkata**       |

They agree only when the process zone _is_ the hospital's zone. Nothing enforces that: **no
Dockerfile, compose file or `.env.example` sets `TZ`**, so the shipped image runs UTC. Verified by
direct probe — an instant the scheduler treats as "Monday 09:15" renders to the patient as
**`02:45 pm`**.

So on any real deployment, a clinic's "Monday 09:00–13:00" session is offered at 09:00–13:00 **UTC**
(14:30–18:30 IST), and the confirmation email tells the patient a time 5½ hours from the one the
clinic booked. `formatWhen`'s own comment describes the failure exactly: _"a reminder that says
09:00 when the clinic means 14:30 is worse than sending nothing at all."_

**Why the suite never caught it:** the developer machine is `Asia/Calcutta`, so the machine zone and
the hospital zone coincide and both implementations produce the same string. The test named
"renders the time in the hospital's timezone, not UTC" was, on the machine where it was run,
**incapable of failing for the bug it describes.**

**Not fixed here, deliberately.** The correct zone for a session is a design decision — the tenant
default, or the branch's own zone, which `branch.model.ts` explicitly allows to differ — and it
belongs in a milestone with its own tests, not in a CI commit. Nothing is deployed (`main` is at the
initial commit), so there is no live patient exposure. What _was_ done is one line in
`apps/api/vitest.config.ts`: **`TZ: "Asia/Kolkata"`**, pinning the process zone so the suite stops
being a property of the laptop it runs on. That reproduces today's behaviour deterministically
everywhere; it does not endorse it. It is a no-op on the developer machine, which is already IST.

**This is the strongest argument in this document for getting CI running.** It found a real defect
within minutes of first execution, in a module that had 1363 passing tests over it.

### Resources: CI does not have the local problem

|         | Developer machine                                                                      | GitHub `ubuntu-latest`      |
| ------- | -------------------------------------------------------------------------------------- | --------------------------- |
| Memory  | 7.75 GB **shared with ~30 containers** from other projects                             | 16 GB, 3 service containers |
| CPU     | 10 cores, contended                                                                    | 4 vCPU, dedicated           |
| Outcome | Mongo OOM-killed (`Exited 137`); the Docker **daemon itself died** during this session | headroom                    |

**Measured, not estimated.** The entire CI workload — Mongo, Redis, Mailhog and Node running all
1363 integration tests — peaks at **~1.21 GB** (Mongo 732 MB · Node 444 MB · Mailhog 24 MB · Redis
11 MB). That is **7.6% of a runner's 16 GB**. Disk: ~1.8 GB of images plus ~965 MB of checkout and
dependencies, against 14 GB free.

The OOM caveat recorded above is therefore **local only**, and **no alternative execution strategy
is needed** — the full suite runs as one job, exactly as written, with no coverage sacrificed and
nothing split, sharded or skipped.

### The workflow validated as a workflow

`actionlint` (which runs shellcheck over every `run:` block) reports **no issues**. That covers the
YAML, every `${{ }}` expression including the `cancel-in-progress` condition, the inputs of all
three actions, the service definitions, and the shell in each step. It found one real thing on the
way — an unused loop counter in the MongoDB wait, fixed — and a linter left with one standing
warning is a linter whose next warning nobody reads.

```
docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:latest    # exit 0, no output
```

### `pnpm gate` — the same checks, runnable by hand

While Actions is blocked, **a human running the gate IS the gate**, and it was seven commands in a
particular order that only the YAML recorded. `pnpm gate` now runs exactly the sequence the workflow
runs — format, lint, typecheck, unit, integration, build, boundaries. Not a second test strategy:
the same package scripts CI invokes, in CI's order, so the two can be compared by reading them.
(The name was checked against pnpm's built-ins first — `Command "gate" not found` — which is the
test `scripts/verify.mjs` documents after `pnpm audit` and `pnpm doctor` were both silently
shadowed.)

`pnpm verify` is unrelated and stays as it is: it answers "is my local stack running" — Docker, DNS,
CORS, a real login — not "is this releasable".

### Branch protection

Written up concretely in [`.github/BRANCH_PROTECTION.md`](.github/BRANCH_PROTECTION.md) — the exact
settings, the `gh` commands, and the order to apply them in. Nothing has been applied. Three points
from it worth surfacing here:

- **The required check is `ci`, lowercase** — the job id, not the workflow name. `CI` would never
  match and the branch would wait forever.
- **Do not require an approving review while there is one maintainer.** GitHub does not let you
  approve your own PR, so `required_approving_review_count: 1` on a solo repository means nothing
  can ever merge. Same shape of trap as requiring a check that cannot run.
- **`squash_merge_commit_title=PR_TITLE` is load-bearing** and is a repository setting, not a
  branch rule. CI lints the PR title because squash-merge makes it the commit message on `main`;
  under GitHub's default a single-commit PR uses the commit message instead, and the thing CI
  validated is no longer the thing that lands.

### 🔴 The release gate is GREEN but NOT DETERMINISTIC

Repeated full runs found an **intermittent failure in `rbac.int.test.ts`, roughly 1 run in 4**. It
was not introduced by this milestone — the earlier `1363/1363` results in this document are real,
but they were samples of a suite that does not always agree with itself, and reporting them without
this paragraph would have been reporting luck as a property.

Two manifestations seen so far, both in the same file:

| Symptom                                                                                               | Reading                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `DOCTOR may NOT POST /api/v1/invoices/:id/discount` — **timed out after 20 s**                        | Unambiguously environmental: the machine was running 31 containers. |
| `a user with no role…` — `POST /api/v1/package-enrollments/:id/cancel` returned **404**, expected 403 | **Not yet explained.** See below.                                   |

What was established about the 404, so the next person does not repeat it:

- Tenant resolution is **not** the cause — it returns 404, but the access log for a comparable
  request carries `tenant` and `userId`, so resolution succeeded.
- The entitlement and permission layers are **not** the cause — both refuse with **403**
  (`HMS-PLAN-002`, `HMS-AUTH-005`), never 404.
- The catch-all `notFoundHandler` is **not** the cause — it would log the unmatched path with the
  literal ObjectId in it, and no such line exists in the run.
- Most tellingly: in the failing run the unroled user's request to that route produced **no access
  log line at all** (5 lines for that route where a passing run has 6), even though `requestLog` is
  the third middleware in `app.ts` and registers its `finish` handler before anything can answer.

So the request appears not to have completed through the normal chain, while the test still observed
a 404. Root cause **not established**; it is recorded here rather than guessed at.

**This must be resolved before `ci` becomes a required status check.** A gate that is red one run in
four teaches everyone to press re-run, which is the failure mode this whole milestone exists to
avoid — and the one warned about at the top of this section.

**The discriminating experiment was run.** The same suite, six consecutive times, against **fresh,
private** Mongo/Redis/Mailhog in a container sharing one network namespace — CI's topology:

```
isolated run 1..6:  Tests  1181 passed (1181)   ×6
```

Six passes, against **1 failure in 3** on the long-lived shared dev containers. That points away
from the test code and towards the **state or health of the dev infrastructure** — a Mongo that has
been running for weeks and OOM-killed repeatedly, versus one that starts clean. CI always starts
clean, so CI is the favourable case.

Stated honestly, this is **suggestive, not conclusive**: if the true per-run failure rate were the
observed 1-in-3, six consecutive passes would still happen by chance about 9% of the time. It is
evidence, not proof, and the finding stays open until a green run is seen on a real runner.

### What is still open

1. **The billing lock.** Until it is cleared, nothing below can happen. A **self-hosted runner on
   the HMS VPS** is the obvious fallback given each project now has its own VPS — with the caveat
   that an account-level lock may disable Actions wholesale, self-hosted included. Worth ten minutes
   to test before assuming either way.
2. **`main` is not protected** (`"protected": false`, no required status checks) and **must not be**
   yet: a required `ci` check that can never run would make `main` permanently unmergeable — worse
   than no protection. Enable it immediately after the first green run, not before.
3. **The commits are not pushed.** `git push` over SSH fails because `~/.ssh/id_ed25519` is
   passphrase-locked and not in the agent; over HTTPS it fails because the `gh` token lacks the
   `workflow` scope. Either `ssh-add ~/.ssh/id_ed25519` or
   `gh auth refresh -h github.com -s workflow` unblocks it.
4. **The timezone defect above** — the highest-value thing CI found, and unfixed by design.

### Gaps against Doc 04 §7, left deliberately

Security scans (`pnpm audit`, Trivy, CodeQL, gitleaks), e2e (Playwright/Detox), SBOM generation and
the coverage gate are all in the target pipeline and are all **P9** per the workflow's own header.
Not added here — the brief was to make the existing correctness gates execute, not to grow the
pipeline. Two smaller notes: there is **no turbo remote cache**, so every run is cold (~15 min is
the expectation, not a regression); and commitlint validates the **PR title** only, which is correct
for squash-merge, with individual commits covered by the local husky `commit-msg` hook.

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
