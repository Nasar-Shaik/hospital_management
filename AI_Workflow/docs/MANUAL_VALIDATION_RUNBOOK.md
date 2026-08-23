# MANUAL VALIDATION RUNBOOK — M2, M3 and Web

> # ⚠️ SUPERSEDED AS A CAMPAIGN — 2026-08-18
>
> **The manual campaign this document describes was deliberately replaced by automated engineering
> validation.** Nobody is expected to execute the 232 rows below.
>
> Every scenario was audited against the existing suites and re-homed at the lowest layer that can
> actually prove it: security, clinical state, schema drift, concurrency, idempotency and timezone
> logic are proven by API and integration tests; browser-dependent behaviour is proven by a
> Playwright critical-path suite (`pnpm test:e2e`). **The audit, the layer chosen for each row, and
> the scenarios that remain genuinely un-automatable are in [`TESTING.md`](../../TESTING.md) §11.**
>
> **This document is still the authority for WHAT each ID means** — its invariants, expected
> results, error codes, fixtures and traps are what the automated tests were written from, and
> several of them are quoted verbatim in test comments. Read it to understand a scenario. Do not
> work through it as a checklist.
>
> **All 232 IDs have since been re-homed into
> [`docs/testing/HMS_ROLE_BASED_UAT_TEST_PLAN.md`](../../docs/testing/HMS_ROLE_BASED_UAT_TEST_PLAN.md)
> (2026-08-22)** — reorganised role → module → workflow → scenario, each carrying the test files that
> cover it and a manual status. **Nothing was dropped**; the mapping table in its §21 names the new
> home of every row here, and its §21.2 lists the eleven rows whose expected result has changed since
> this document was written. **That plan is what a person executes. This file is what they read to
> understand a row.**
>
> **No row here has ever been executed by a human, and none may be marked PASS.** Automated
> coverage is recorded as `AUTOMATED — PROVEN` / `STRENGTHENED` / `PLAYWRIGHT`, never as a manual
> pass.
>
> **Two rows disagreed with the implementation and have since been decided on the evidence**
> (`TESTING.md` §11). **WEB-02** was right and the product has been changed to match it — the
> address is now named on load, not on submit. **WEB-04** was over-specified against its own §9 and
> the row below has been amended; the product was not changed. Both rows read as decided, not open.

**Status: PREPARED, NOT EXECUTED.** Every test below is written to be run later. Nothing in this
document records a result, and no row here may be ticked from automated evidence.

**Authoritative for:** how manual validation is prepared, what is tested, what should happen, what
evidence to capture, and what to escalate. Where this document and an older checklist disagree, this
one is current — it was reconciled against the implementation on 2026-08-16 at `39e2dff`, and again
on **2026-08-17**, when four instructions were found that had never been executed (§21).

**Companion documents, still worth reading, now narrative rather than procedural:**

- [`MOBILE_M2_DEVICE_CHECKLIST.md`](MOBILE_M2_DEVICE_CHECKLIST.md) — 61 hardware rows for the doctor
  app, and a good explanation of _why_ each is beyond CI's reach.
- [`MOBILE_M3_DEVICE_CHECKLIST.md`](MOBILE_M3_DEVICE_CHECKLIST.md) — 45 hardware rows for the nurse
  app, plus what the API probe already proved.
- [`MOBILE_M3_NURSE_AUDIT.md`](MOBILE_M3_NURSE_AUDIT.md) — the design reasoning behind MAR safety.

They keep their tick-boxes. **This runbook owns the test IDs**, because a result you cannot cite is a
result nobody can re-run.

---

## 1. PURPOSE

### Why manual validation exists

The automated suites are large and they are honest about their own boundary. The mobile strategy
deliberately puts everything worth defending outside React, so the suite runs in Node with no
renderer, no simulator and no Android SDK. That buys speed, and it leaves one category untouched:
**anything whose failure is a rendered pixel, an OS prompt, a real radio, a real second person, or a
clock that disagrees with the server's.**

### What automation cannot prove

| Cannot be proven in CI            | Why                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| A blank patient name on screen    | The test asserts the field is in the payload, not that it renders                         |
| A UHID unreadable at arm's length | No test has eyes                                                                          |
| The OS biometric sheet            | No enrolled fingerprint, no Face ID, no secure enclave in CI                              |
| Two nurses racing one dose        | Two test clients are one process; two people are not                                      |
| A lost response                   | A mocked network failure is a decision; a radio losing a packet mid-commit is an accident |
| A phone whose clock is 9½h out    | The suite fakes a timezone; a device _lives_ in one                                       |
| Layout at largest OS text size    | Nothing measures overflow                                                                 |

### What this runbook validates

The **client surfaces** — the Expo doctor app (M2), the Expo nurse app (M3), and the Next.js web app
— against a database that has been proven able to enforce the rules being tested.

### What this runbook does NOT validate

- **Server correctness.** The API beneath M3 was separately probed over real HTTP on 2026-08-14 (43
  checks, including two real nurse sessions racing one dose). That is why a failure in §7–§9 below
  should be treated as a **client** defect until proven otherwise — but it is also why no row here
  may be marked PASS because the probe passed.
- **Load, soak or performance at scale.** See `PERFORMANCE_BUDGET.md`.
- **Security penetration.** See risk register S1.
- **Fleet-wide schema convergence.** The gate in §3 covers _one tenant at validation time_. Risk
  register **T2 remains open** and this runbook does not close it.

---

## 2. HOW TO USE THIS DOCUMENT

### 2.1 Test case shape

Every test has: **ID · Purpose · Preconditions · Role · Surface · Steps · Expected · Evidence ·
Concern**. "Concern" is the failure criterion — what makes this a defect worth stopping for, as
opposed to a note.

### 2.2 Result classification

Use exactly these. Do not invent a sixth.

| Result                        | Means                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**                      | Observed with your own eyes, on the stated surface, in this environment, at a recorded time.                                             |
| **FAIL**                      | Observed behaviour differs from Expected.                                                                                                |
| **BLOCKED**                   | Could not run: missing hardware, missing environment state, or an unmet prerequisite. Say which.                                         |
| **ENVIRONMENT ISSUE**         | The failure is in the harness, not the product — API down, wrong `TENANT_BASE_DOMAIN`, unconverged schema. Not a defect; fix and re-run. |
| **DATA ISSUE**                | The seeded data does not support the test (no overdue dose yet, ward already populated). Not a defect.                                   |
| **KNOWN DEFECT**              | Matches an entry in §19. Record the evidence, cite the ID, move on. Do not re-report.                                                    |
| **PRODUCT DECISION REQUIRED** | The behaviour is coherent but the repository never states what it _should_ be. Escalate; do not guess.                                   |
| **N/A**                       | Genuinely inapplicable to this surface or edition.                                                                                       |

### 2.3 Three rules that decide whether this exercise was worth doing

1. **Never convert an automated PASS into a manual PASS.** If CI proves it, the manual row is a
   sanity check at best; if you did not perform it, it is not done.
2. **Never convert an untested scenario into PASS.** "Looked fine" is not a result. BLOCKED is a
   perfectly respectable answer and is more useful than a guess.
3. **Never invent an Expected result.** If the repo does not define the behaviour, write
   `PRODUCT DECISION REQUIRED` and describe what you saw. A tester's opinion silently becoming the
   spec is how a product acquires requirements nobody agreed to.

### 2.4 Safety rule for a clinical product

All data is synthetic. **No test requires performing an unsafe clinical action to prove a safety
control works.** Every negative test in §16 verifies that the unsafe action is _refused_ — you attempt
it and observe the refusal. You never chart a wrong drug, a wrong dose or a wrong patient to see what
happens.

If a scenario would leave the environment in a state you cannot explain, stop that scenario, capture
what you have, and continue only with independent tests.

### 2.5 If you find a P0/P1 safety failure

Stop the affected workflow immediately. Capture §18's extended evidence set. Do not patch, do not
retry to "see if it happens again" before recording the first occurrence, and do not continue tests
that depend on the same mechanism. Report before proceeding.

---

## 3. PREREQUISITES — ENV

Run in order. **ENV-04 is a hard gate: if it does not print READY, every clinical result taken
afterwards is void.**

### ENV-01 · Infrastructure up

```bash
pnpm docker:dev     # databases; leave running
pnpm dev            # API :4000, web :3000, workers; leave running
```

**Expected:** `curl -s -o /dev/null -w '%{http_code}' http://localhost:4000/health` → `200`.

> **If Mongo dies or containers show `Exited (137)`,** that is the local Docker memory ceiling, not a
> flaky test. Free memory and restart before blaming anything in this document.

### ENV-02 · Accounts and hospitals

```bash
pnpm seed:operator
pnpm seed:demo
```

Creates the console operator, Sunrise and District, and all staff — including **two nurses**, which
exist specifically so §8 can be run by two identities rather than one account signed in twice.

### ENV-03 · Schema convergence across every tenant

```bash
pnpm seed:migrate --all        # converge every tenant
pnpm seed:migrate --check      # read-only: is the fleet ACTUALLY converged?
```

**Expected:** every tenant logs `tenant converged`, then `--check` logs `ready` for each and
`READY — every tenant is on this release's schema, and it is armed`, exiting 0.

A non-zero exit distinguishes **1** (a database was inspected and its schema is wrong — validation
results taken against it are void) from **2** (the check could not complete, so nothing is known
either way). Each tenant carries its own remedy, and for three of the seven failure categories the
remedy is _not_ `seed:migrate` — see [DEPLOYMENT_GATE.md](./DEPLOYMENT_GATE.md).

`--check` writes nothing and is the honest answer: it verifies the migration records **and** that
the clinical invariants are armed in the database. Any tenant it lists as `drifted` has the
migration recorded but the constraint missing, and `--all` will **skip** it — clear the record for
the named migration first.

> ⚠️ **This is the step people skip, and skipping it has already cost a day.** Migrations run inside
> hospital _provisioning_, and `seed:demo` skips provisioning for a hospital that already exists. A
> database created before M3 therefore has no `one_administration_per_dose_slot` index — the
> constraint that stops one dose being charted twice — and **nothing on any screen says so.** On
> 2026-08-14 all four local tenants were in that state; a probe against them reported seven
> catastrophic safety failures that were _entirely_ the missing index. (Risk register T2.)
>
> ⚠️ **`tenant converged` is weaker evidence than it sounds.** The runner skips any migration already
> recorded, so if a constraint was dropped by hand or restored from an older backup, this prints
> `migrationsApplied: []` and "converged" while changing nothing. ENV-04 is what actually checks.

### ENV-04 · 🔴 THE GATE — build and verify the validation ward

```bash
pnpm seed:validation                 # builds the ward; refuses on an unenforceable schema
pnpm seed:validation -- --verify     # read-only; must print READY
```

**Expected — the schema block first, then the data block:**

```
  SCHEMA — the database can enforce what is being validated
  ✓ the same scheduled dose cannot be charted twice
  ✓ one Idempotency-Key claim survives, so a retry replays instead of repeating
  ✓ every migration applied (49)
  DATA
  ✓ … 19 checks …
  READY — schema armed, every data check passed.
```

**If it prints `VALIDATION BLOCKED`: STOP.** Do not begin clinical validation. The message names the
missing invariant, what breaks without it, and the correct remedy — which differs depending on
whether the migration never ran or the index was dropped afterwards. Follow it, re-run, and only then
continue.

`--verify` writes nothing and is safe to re-run at any point. Re-run it **after** the campaign too:
if it still says READY, the environment you tested is the environment you think you tested.

### ENV-05 · What the ward contains

| Item                | Value                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant              | `sunrise`                                                                                                                                                                 |
| Branch A            | **Main Branch** · `Asia/Kolkata` · ward **General Ward** · beds `GW-1`…`GW-45` · 42 admitted                                                                              |
| Branch B            | second site · `America/New_York` · ward **Annexe Ward** · beds `AW-…` · 3 admitted                                                                                        |
| Long-stay patient   | bed **GW-1**, registered _first_, pushed outside the 100-most-recent window (web defect D-1)                                                                              |
| Medicated patients  | 12, from 6 prescription shapes                                                                                                                                            |
| Quiet patients      | 30 with nothing due — the "No scheduled doses today" case                                                                                                                 |
| Drugs               | Paracetamol 500mg (500 mg) · Pantoprazole 40mg (40 mg) · Metformin 500mg (500 mg) · Amlodipine 5mg (5 mg) · Cetirizine 10mg (10 mg) — **all route `oral`, 5-day courses** |
| `lineIndex` cases   | a 3-line prescription (identity is a _position_), and the **same drug scheduled AND as-required**                                                                         |
| Allergies           | ≥1 severe                                                                                                                                                                 |
| Deliberately absent | **no vitals, no nursing notes, no administered doses** — those are the writes you are here to make                                                                        |

**Round times** (`DEFAULT_ROUND_TIMES`): OD 08 · BD 08/20 · TDS 08/14/20 · QID 06/12/18/22 · HS 22 ·
SOS as-required · STAT once.

> **Overdue doses are a clock state, not a seeded row.** A course runs from the prescription's
> `signedAt`, so a prescription signed at noon has no 08:00 dose to be late for. `--verify` prints the
> wall-clock minute the first overdue dose appears. **Seed before 08:00 ward time** if you want a full
> day of natural due→overdue transitions. `OVERDUE_AFTER_MS` is 1 hour.
>
> **Do not backdate `signedAt` to manufacture an overdue dose.** It is a medico-legal timestamp;
> falsifying it to make a test convenient is not a testing technique.

### ENV-06 · Reaching the API from a handset — do this once for the whole campaign

A phone cannot use `localhost`, and an IP does not help because the server reads the tenant from the
**subdomain**. `apps/mobile/app.config.ts` solves it by building `<your-lan-ip>.sslip.io`, and
`pnpm --filter @medicore/mobile start` prints the exact value the API must match:

```
📱 mobile will call  http://<hospital>.192.168.1.7.sslip.io:4000
   the API needs     TENANT_BASE_DOMAIN=192.168.1.7.sslip.io  (apps/api/.env)
```

Confirm the host resolves a tenant _before_ picking up the phone — a tenant-resolution failure and a
wifi failure are indistinguishable from a handset:

```bash
curl -s -H 'Host: sunrise.192.168.1.7.sslip.io' http://192.168.1.7:4000/api/v1/auth/login \
  -X POST -H 'Content-Type: application/json' -d '{}'
# HMS-VAL-001 → tenant resolved, only credentials missing. Good.
# HMS-TEN-001 → host did not match a tenant. The two domains disagree.
```

> **Sequencing consequence, and the reason this is one step rather than two.**
> `TENANT_BASE_DOMAIN` also drives the dev CORS allowlist (`*.<domain>`), so while it is set to
> sslip the web app must be browsed at **`sunrise.192.168.1.7.sslip.io:3000`**, not
> `sunrise.localhost:3000`. **Set it once at the start of the campaign and use sslip URLs on every
> surface**, rather than switching back and forth — each switch needs an API restart and a
> `pnpm start -c`, and a half-switched environment produces failures that look like product defects.
>
> `app.config.ts` is read when **Metro starts**. Changing networks or editing it does nothing until
> `pnpm start -c`; a stale domain in the hospital screen's hint is the quickest tell.

Full detail: [`apps/mobile/README.md`](../../apps/mobile/README.md) §"A physical phone cannot use
`localhost`".

### ENV-07 · Mobile build — Expo Go or a development build?

**Verify this; do not assume it.**

What is confirmed by inspection at `39e2dff`: the app is **managed workflow** (no `android/` or `ios/`
directories), there is **no `expo-dev-client` dependency**, config plugins are `expo-router` and
`expo-secure-store`, and every native dependency is an Expo-maintained module —
`expo-local-authentication ~17.0.8`, `expo-secure-store ~15.0.8`, `expo-constants`, `expo-linking`,
`expo-router ~6.0.24`, `expo-status-bar`, `expo-system-ui`, `@react-native-async-storage/async-storage`,
`react-native-safe-area-context`, `react-native-screens`, on Expo SDK `~54.0.36` /
React Native `0.81.5`.

**That is consistent with Expo Go and is not proof.** The confirming test is:

| ID         | Steps                                                               | Expected                                                                                                            |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **ENV-07** | `pnpm --filter @medicore/mobile start`, scan with Expo Go, sign in. | App loads and reaches a signed-in screen. Then open Settings and enable the screen lock: the OS prompt must appear. |

If either fails in Expo Go, record **ENVIRONMENT ISSUE**, build a development build, note it here, and
**correct the two device checklists**, which currently both state "Expo Go is sufficient".

> Known caveat: `expo-secure-store` inside Expo Go shares storage scope with other Expo Go projects.
> Harmless for validation; it is not how a real build behaves.

> **M4 push is settled, and the answer is no (2026-08-20).** Expo Go has not carried remote
> notifications since SDK 53, so the eighteen rows of `MOBILE_M4_DEVICE_CHECKLIST.md` cannot be run
> in it at all — the app mints no token, registers no device, and looks exactly like a handset whose
> user declined the permission. A development build is required, and so is an EAS project before
> that. `MOBILE_PUSH_ENABLEMENT.md` is the runbook. This does not change the answer for M2 and M3,
> which may well be fine in Expo Go; it means the M4 rows have a prerequisite the others do not.

> **Reaching the API: prefer `pnpm --filter @medicore/api dev:device-domains` over ENV-06's
> `TENANT_BASE_DOMAIN` switch.** It attaches `<slug>.<ip>.sslip.io` to each tenant as a custom
> domain — the production path for a hospital with its own hostname — so the phone and the browser
> both work without moving CORS, and without the switching cost the box above warns about.

### ENV-08 · Devices and browsers

See §17. Confirm what you actually have before planning the day — several tests need **two
simultaneous nurse identities on two devices**, and §14's lost-response tests need a device whose
radio you can kill mid-request.

---

## 4. TEST ACCOUNTS

All synthetic. Password for every account below is `123456`. **No real credentials appear in this
document and none may be added to it.**

| Alias            | Account                    | Role           | Used by                                             |
| ---------------- | -------------------------- | -------------- | --------------------------------------------------- |
| **Nurse A**      | `nurse@sunrise.test`       | NURSE          | M3, five rights, MAR, vitals, notes, negative       |
| **Nurse B**      | `nurse2@sunrise.test`      | NURSE          | MAR concurrency (§8), staleness (M3-24)             |
| **Doctor**       | `drrao@sunrise.test`       | DOCTOR         | All of M2; permission denials in §15                |
| **Doctor 2**     | `drkhan@sunrise.test`      | DOCTOR         | **§13A JR-06** — handover, the one test needing two |
| **Receptionist** | `reception@sunrise.test`   | RECEPTIONIST   | §15 denials; D2 reception timezone (§12); §13A      |
| **Pharmacist**   | `pharmacy@sunrise.test`    | PHARMACIST     | **DRIFT-03**, §13A dispensing, DUP-01               |
| **Lab tech**     | `labtech@sunrise.test`     | LAB_TECHNICIAN | **DRIFT-04** (accept/start/complete), §13A          |
| **Pathologist**  | `pathologist@sunrise.test` | PATHOLOGIST    | **DRIFT-04** (verify/release) — a different person  |
| **Radiologist**  | `radiologist@sunrise.test` | RADIOLOGIST    | §13A imaging orders                                 |
| **Cashier**      | `cashier@sunrise.test`     | CASHIER        | **§13A billing**, JR-12/13                          |
| **Tenant admin** | `admin@sunrise.test`       | TENANT_ADMIN   | Branch config, deactivating a branch (BR-06)        |
| **Operator**     | `ops@paperlesstech.in`     | SUPERADMIN     | §18 licence states — or use `pnpm seed:licence`     |

> **The lower six were missing from this table until 2026-08-17, and three tests already in this
> document could not be run without them.** DRIFT-03 says "hand over drugs" — no listed account held
> `pharmacy:dispense`. DRIFT-04 says "the lab can still accept / start / complete / verify /
> release" — that is deliberately **two** people (a technician performs, a pathologist verifies;
> §15's own state machine says collapsing them is a patient-safety failure), and neither was listed.
> All eleven are created by `pnpm seed:demo` as `<key>@sunrise.test`; none is new. A tester meeting
> DRIFT-03 with only the original six would have recorded BLOCKED against a working feature.

Both nurses are **hospital-wide** (no branch binding), which is what makes branch _switching_ testable
and is why BR-07 — the branch-_confined_ user — is currently BLOCKED.

**Nurse permissions**, from `packages/permissions/src/index.ts`: `patient:read`, `encounter:read`,
`encounter:update`, `record:read`, `consent:manage`, `emr:read`, `vitals:record`, `allergy:read`,
`allergy:manage`, `nursing:manage`, `mar:administer`, `lab:collect`, `order:read`, `order:perform`,
`bed:allocate`, `mortuary:manage`, `mortuary:release`, `appointment:read`, `file:read`.

**A nurse deliberately does NOT hold `emr:write`** (the doctor's clinical note) or `encounter:close`.
Both are tested in §15.

---

## 5. RECOMMENDED EXECUTION ORDER

### 5.0 🔴 RUN THESE FIRST — the 2026-08-17 security audit's regression set

Five rows, roughly an hour, mostly `curl`. They come before everything else because of what that
audit found: **three cross-branch defects, in code that had passed review with green tests, on
paths no automated test walked with two branches configured.** One of them was a WRITE. A fourth
finding was a branch-isolation test that had been asserting against a route that does not exist —
green, and proving nothing.

That is the argument for this ordering. Automated coverage of the branch dimension was wrong three
times in one day, so the human should look there first, while fresh.

| Order | Row             | Why it is first                                                                                                                                                                                                                                                           |
| ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **BR-10**       | Cross-branch report **file** (D10). **The least clickable row in this document** — the list was already scoped, so the UI never offered the link while the API served the PDF. A tester following screens would report everything as working. It must be probed directly. |
| **2** | **BR-11**       | Cross-branch appointment **write** (D9) — the only confirmed cross-branch write. Read its **Trap** row first: before the fix the first exploit succeeded and the next two returned 422, refused by the state machine, which looks exactly like a working boundary.        |
| **3** | **BR-07**       | The branch-**confined** nurse. The account with the least coverage in the product, and the one the audit's findings all lived behind. Unblock it (§18-style account creation, no code).                                                                                   |
| **4** | **DRIFT-01…12** | §16A. Five clinical refusals now exist that **no human has ever seen on a screen**, and the phone's wording for them changed on 2026-08-17 — DRIFT-10 is the row most likely to find something real.                                                                      |
| **5** | **BR-12**       | The negative control: the wallet advance is hospital-wide **on purpose**. It is here so nobody "fixes" it — which is exactly what the audit did before reading the account model.                                                                                         |

**If any of the first three fails, stop and report before continuing.** They are regression checks
on fixes that are two days old, and a failure means the fix did not hold on a real client.

### 5.1 Then the full campaign

The order below differs from the obvious one in three places, each for a reason.

| #      | Phase                                           | Why here                                                                                                                                                                                                                                                                            |
| ------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | §3 Environment (ENV-01…08)                      | A gate. Nothing downstream is meaningful without it.                                                                                                                                                                                                                                |
| **2**  | §15 Permissions **by API**                      | **Moved earlier.** ~15 minutes of `curl`, and it tells you the role model you are about to trust is intact. Finding a permission hole _after_ a day of role-based UI testing invalidates the day.                                                                                   |
| **3**  | §13 **Web** (WEB-01…24)                         | **Moved before mobile.** No build, no device, no pairing, no DNS. And it is the _less_ proven surface: the mobile MAR carries 1,613 tests, whereas web defects D-1 and D-2 were fixed and have **never been opened in a browser**. Highest defect probability per minute of effort. |
| **3b** | §13A **Journey** (JR-01…22 + DUP-01/02, TEN-01) | **New 2026-08-17.** One patient, front desk to bill. Every flow here was previously untested by any row in this document, so it has the highest chance of finding something nobody has looked at — and it is the only section where a failure legitimately blocks the next step.    |
| **4**  | §6 M2 foundation gate                           | M2-01…M2-12 only. This is the prerequisite for anything auth-, session- or branch-related in M3.                                                                                                                                                                                    |
| **5**  | §7 M3 core (worklist → notes)                   | The nurse's ordinary shift.                                                                                                                                                                                                                                                         |
| **6**  | §8 MAR safety + §9 five rights                  | The reason the product was built this way. Needs two people and full attention — do it fresh, not at 18:00.                                                                                                                                                                         |
| **7**  | §10 Lost response                               | Needs a cooperative radio and steady hands. Do it while still fresh.                                                                                                                                                                                                                |
| **8**  | §11 Branch isolation, remainder                 | BR-01…BR-06, BR-08, BR-09. The security rows (BR-07, BR-10…BR-12) were already run in §5.0. BR-05 is now a **regression** check — D1 is fixed, so expect a refusal, not rows.                                                                                                       |
| **9**  | §12 Timezone                                    | Some rows are only meaningful near a midnight; plan around the clock rather than the checklist order.                                                                                                                                                                               |
| **10** | §6 M2 remainder                                 | The biometric lock (largest unverified block in M2), accessibility, network.                                                                                                                                                                                                        |
| **11** | §18 Licence / edition                           | LIC-01…05 **PREPARED** (`pnpm seed:licence`, §18.1). LIC-06 still blocked — needs an edition without the nursing module.                                                                                                                                                            |

**Deviate if you have a reason and write the reason down.** If only one device is available on the
day, run everything except §8 and mark those BLOCKED rather than faking a second nurse with one
account in two browsers — one account is one identity, which is exactly what that test must not have.

---

## 6. M2 — DOCTOR MOBILE

Surface: Expo app · Role: **Doctor** unless stated. **M2-01…M2-12 are the foundation gate.**

### A. Authentication and session

| ID        | Purpose                   | Steps                                                                   | Expected                                                                                     | Concern                                               |
| --------- | ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **M2-01** | Login succeeds            | Enter hospital code `sunrise`, correct credentials.                     | Reaches the doctor's home with a populated tab bar — not a blank one.                        | Empty tab bar = permission→navigation break.          |
| **M2-02** | Login fails safely        | Wrong password.                                                         | Inline message; **the email field is not cleared**.                                          | Clearing it teaches users to distrust the app.        |
| **M2-03** | MFA                       | On an MFA-enabled account, submit a wrong code then the right one.      | Recoverable without restarting the login.                                                    | N/A if no MFA account exists — say so.                |
| **M2-04** | Cold start, live session  | Force-quit, relaunch.                                                   | **Exactly one splash frame**, straight into the app. Never a flash of the sign-in screen.    | A sign-in flash trains returning users to type.       |
| **M2-05** | Cold start, dead session  | Delete the refresh token server-side (or wait past its life), relaunch. | Sign-in screen with a plain message. Not an unresolving spinner.                             | Spinner = unhandled refresh failure.                  |
| **M2-06** | Token refresh mid-session | Leave open past the access token's 15 min, then tap something.          | Works with no visible interruption.                                                          | A logout here is a rotation defect.                   |
| **M2-07** | Logout                    | Sign out, then use the back gesture.                                    | Lands on sign-in; **back does not return to a chart**.                                       | A reachable chart after logout is a P1.               |
| **M2-08** | Offline logout            | Airplane mode, then sign out.                                           | Completes locally in ~3 s and lands on sign-in.                                              | This one fails **silently** if the timeout regresses. |
| **M2-09** | Session expiry mid-write  | Revoke the session server-side while a consultation is open, then save. | Explicit "session ended" and a route to sign-in. Typed text must not vanish without warning. | Silent data loss.                                     |

### B. Branch

| ID        | Purpose                | Steps                                                             | Expected                                                                                                                         | Concern                                               |
| --------- | ---------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **M2-10** | Branch on arrival      | Sign in, read the header.                                         | Shows a **validated** branch, not merely the remembered one.                                                                     | A remembered-but-invalid branch scopes reads wrongly. |
| **M2-11** | Switch A → B           | Switch from the header.                                           | Every list on screen repaints with B's data. **Nothing from A survives.**                                                        | A surviving row is cross-branch display of PHI.       |
| **M2-12** | Switch back B → A      | Switch back.                                                      | Re-reads. Not a stale frame of the earlier data.                                                                                 | Same.                                                 |
| **M2-13** | Branch deactivated     | As tenant admin, set the current branch inactive; resume the app. | Falls back to a valid branch rather than continuing to send the dead one.                                                        | Requests against a dead branch.                       |
| **M2-14** | All-branches aggregate | If the account can aggregate, open a write screen.                | Lists span sites; every write screen says "Choose which site you are working at before saving" and the save control is disabled. | A write with no site is unattributable clinical data. |
| **M2-15** | Cross-branch deep link | While in branch B, deep-link `/patient/<a-branch-A-patient-id>`.  | "Not available here". **It must never render.**                                                                                  | Rendering it is a P1 PHI exposure.                    |

### C. Clinical reads

| ID        | Purpose               | Steps                                                      | Expected                                                                                               | Concern                                              |
| --------- | --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| **M2-16** | Queue / patient list  | Open the queue; scroll.                                    | Pages on scroll; a doctor with nobody booked gets a real empty state, not a blank page.                |                                                      |
| **M2-17** | Patient identity      | Open a chart.                                              | Identity reads **name → UHID → age/sex**, in that order; UHID readable digit-by-digit at arm's length. | See §9 — identity is a safety field.                 |
| **M2-18** | Age is the hospital's | Set the device to `Pacific/Kiritimati`; reopen the chart.  | Age **does not change**.                                                                               | Device-derived age is a clinical error.              |
| **M2-19** | Vitals display        | Open vitals.                                               | Server's own flags. Nothing on the phone re-assesses a number.                                         | Client-side clinical assessment.                     |
| **M2-20** | Unreleased result     | Open a result not yet verified.                            | Status "Awaiting verification" and **no values**.                                                      | Leaking unverified values is a P1.                   |
| **M2-21** | Critical result       | Open a released critical result.                           | Visibly flagged and sorted to the top.                                                                 |                                                      |
| **M2-22** | Timestamps            | Change the device timezone; re-read.                       | Timestamps carry the branch's zone label and **do not move**.                                          | See §12.                                             |
| **M2-23** | Overflow              | Long patient name, long drug name, a 2,000-character note. | Wrap or truncate. The identity line must not be pushed off screen.                                     | An invisible identity line is a five-rights failure. |
| **M2-24** | Smallest screen       | iPhone SE / 5" Android.                                    | Tab bar, header and save controls reachable one-thumbed.                                               |                                                      |

### D. Clinical writes

| ID        | Purpose                     | Steps                                                                           | Expected                                                                                                          | Concern                                       |
| --------- | --------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **M2-25** | Consultation, discard guard | Type, then leave via **header chevron**, **hardware back**, and **edge swipe**. | The discard prompt fires on all three.                                                                            | Losing typed clinical text.                   |
| **M2-26** | Consultation, save          | Save.                                                                           | Status pill reads "Saved HH:MM" **in the branch's zone**.                                                         |                                               |
| **M2-27** | Consultation, offline       | Airplane mode, save.                                                            | Pill reads **"Not saved"** and the typed words are still on screen.                                               | A false "Saved" is a P1.                      |
| **M2-28** | Order pad                   | Place three tests.                                                              | Three separate requests, clear per-item result.                                                                   |                                               |
| **M2-29** | Prescription, safety alert  | Compose a prescription that trips an allergy/interaction alert; review; sign.   | The alert presents as a **review step**, not as a failed save.                                                    | An alert shown as an error gets clicked past. |
| **M2-30** | Prescription, response lost | Sign, and kill the network the instant you tap. Reopen the prescription.        | Reads **signed** if the server signed it — reconciled from `signedAt`, never from a retry that could double-sign. | A double-signed prescription is a P1.         |
| **M2-31** | Ward note                   | Write one.                                                                      | Appears on the timeline with your name and the time.                                                              |                                               |
| **M2-32** | Ward note, response lost    | Same trick.                                                                     | Either "it is on the chart" or plainly "I do not know". **Never "saved" without evidence.**                       | See §10.                                      |
| **M2-33** | Discharge                   | Discharge a patient.                                                            | Explicit confirmation step; the summary text survives a failure.                                                  | Losing a discharge summary.                   |
| **M2-34** | Disabled controls explain   | Find every disabled save control.                                               | Each **says why**.                                                                                                | A bare greyed-out button is a defect.         |

### E. Screen lock — the largest unverified block in M2

**None of M2-35…M2-47 has ever run on hardware.** Full row text in
[`MOBILE_M2_DEVICE_CHECKLIST.md`](MOBILE_M2_DEVICE_CHECKLIST.md) §5; IDs assigned here so results can
be cited.

| ID        | Scenario                                                   | Expected                                                                                                                    |
| --------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **M2-35** | Enable the lock on a device with **no** enrolled biometric | Still enables, and says plainly "unlocking will use your password". Capability decides the _method_, never whether to lock. |
| **M2-36** | Background < 15 min, resume                                | Straight back in, no prompt                                                                                                 |
| **M2-37** | Background > 15 min, resume                                | The gate is the **first frame** — the chart must not be visible for even a moment                                           |
| **M2-38** | The OS prompt                                              | Appears **by itself**, without a tap                                                                                        |
| **M2-39** | Successful scan                                            | Returns, cache warm, no network round trip                                                                                  |
| **M2-40** | Failed scan (wrong finger)                                 | Stays locked, counter decrements, session survives                                                                          |
| **M2-41** | **Cancelled** prompt                                       | Stays locked, counter **does not move**                                                                                     |
| **M2-42** | "Use password" on the OS sheet                             | Password path offered, no attempt spent                                                                                     |
| **M2-43** | Five failed scans                                          | Signed out cleanly to sign-in, not a dead lock screen                                                                       |
| **M2-44** | Sign out from the lock screen                              | Works on the **first** render                                                                                               |
| **M2-45** | Remove the enrolled biometric while backgrounded, resume   | Gate still appears, offers password. **Must not silently unlock.**                                                          |
| **M2-46** | App switcher                                               | Shows the privacy cover, not a patient                                                                                      |
| **M2-47** | Force-quit while locked, relaunch                          | Session resumes; the lock does not persist across a cold start                                                              |

### F. Accessibility

| ID        | Scenario                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| **M2-48** | Largest OS text size — identity line, save controls and lock screen all usable, nothing clips.                         |
| **M2-49** | VoiceOver / TalkBack — the allergy banner and the lock's attempt warning are announced as **alerts**, not walked onto. |
| **M2-50** | Every tappable target comfortably thumb-hittable (tokens set 48pt; only a hand confirms it).                           |
| **M2-51** | High brightness / sunlight — amber and red banner tones and the critical-result flag remain distinguishable.           |

### G. Not-yet-built areas

| ID        | Purpose              | Expected                                                                                                         |
| --------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **M2-52** | ComingLater surfaces | Any unbuilt area says so plainly and is reachable without crashing. It must not be a blank screen or a dead tab. |

---

## 7. M3 — NURSE MOBILE

Surface: Expo app · Role: **Nurse A** unless stated. M2-01…M2-12 are a prerequisite and are not
repeated.

### A. Login and session

| ID        | Purpose             | Steps                            | Expected                                           | Concern                                     |
| --------- | ------------------- | -------------------------------- | -------------------------------------------------- | ------------------------------------------- |
| **M3-01** | Nurse lands on Ward | Sign in as Nurse A.              | Reaches the **Ward** tab, not a blank tab bar.     | Tab derivation from `nursing:manage` broke. |
| **M3-02** | Cold start          | Force-quit, relaunch.            | One splash frame into the app.                     |                                             |
| **M3-03** | Nurse swap          | Log out, sign in as **Nurse B**. | Nurse B's world — **no cached rows from Nurse A**. | Cross-user cache bleed.                     |

### B. Ward worklist

| ID        | Purpose                | Steps                                            | Expected                                                                                                               | Concern                      |
| --------- | ---------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **M3-04** | Triage order           | Open the ward list.                              | Overdue first, then due, then bed order **numerically** (`GW-2` before `GW-10`). _(CI asserts this — a sanity check.)_ | String ordering hides a bed. |
| **M3-05** | Ward filter round-trip | Pick a ward chip, then pick **All wards** again. | Both directions work. _(This is the S5B fix — the bar used to hide itself with no way back.)_                          | No way back = unusable.      |
| **M3-06** | Long ward scroll       | Scroll the 45-bed ward to the bottom.            | Smooth; next page loads without a visible stall.                                                                       |                              |
| **M3-07** | Pull to refresh        | Pull down.                                       | Rows stay on screen while it spins. **The list must never blank.**                                                     | A blanked list mid-round.    |

### C. Patient identity and chart

| ID        | Purpose                   | Steps                                                | Expected                                                             | Concern                                          |
| --------- | ------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| **M3-08** | Chart in context          | Open a patient from the worklist.                    | Opens with the visit in context (the `encounterId` the S3 bug lost). | Wrong encounter = wrong chart.                   |
| **M3-09** | Identity on every surface | Check worklist row, chart header, dose confirmation. | **Name and UHID present on all three.** See §9.                      | Blank identity is a safety defect, not cosmetic. |

### D. Allergies

| ID        | Purpose        | Steps                                   | Expected                                                                                        | Concern                                                                                                  |
| --------- | -------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **M3-10** | Severe allergy | Open the seeded severe-allergy patient. | Shown on the **worklist row**, the **chart**, and the **dose confirmation screen** — all three. | A missing allergy at the point of giving a drug is the highest-severity display defect in this document. |
| **M3-11** | No allergies   | Open a patient with none recorded.      | Reads "None recorded… That is not the same as no allergies". **Never "no allergies".**          | "No allergies" is a clinical assertion the record cannot support.                                        |

### E. Vitals

| ID        | Purpose            | Steps                             | Expected                                                           | Concern                              |
| --------- | ------------------ | --------------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| **M3-12** | Record vitals      | Enter a full set; save.           | Chart shows the reading **with the ward's time**.                  |                                      |
| **M3-13** | Implausible value  | Enter pulse `900`; save.          | Refused, **and your typed value is still on screen**.              | Silently discarding input.           |
| **M3-14** | Repeat observation | Enter a second set minutes later. | **Both kept.** Vitals are deliberately not unique. _(CI asserts.)_ | Suppressing a legitimate second obs. |
| **M3-15** | Offline            | Airplane mode; try to save.       | Button disabled **with a reason**; nothing claims success.         | False success.                       |
| **M3-16** | Lost response      | → **LR-04** in §10.               |                                                                    |                                      |

### F. Nursing notes

| ID        | Purpose         | Steps                                                                     | Expected                                              | Concern                     |
| --------- | --------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------- |
| **M3-17** | Write a note    | Write and save.                                                           | Appears on the stay's timeline **attributed to you**. |                             |
| **M3-18** | Unsaved-changes | Start typing, **swipe back**.                                             | The prompt appears.                                   | Losing typed clinical text. |
| **M3-19** | Double-tap save | Save the same note twice quickly.                                         | **Exactly one note.**                                 | Duplicate clinical record.  |
| **M3-20** | Wrong endpoint  | → **PERM-05** in §15 — the nurse must be refused the doctor's note route. |                                                       |                             |

### G. Medication schedule and round

| ID        | Purpose               | Steps                                                   | Expected                                                                                             | Concern                                                                                                  |
| --------- | --------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **M3-21** | Round loads           | Open the medication round.                              | One request per page — no per-patient fan-out. _(CI asserts.)_                                       |                                                                                                          |
| **M3-22** | Five-rights read      | Read any dose row.                                      | **name · UHID · bed · drug · dose · route · scheduled time** — all seven. → §9.                      | **Stop and report if any is missing.**                                                                   |
| **M3-23** | Most overdue on top   | Compare against `--verify`'s overdue count.             | The most overdue patient is first.                                                                   |                                                                                                          |
| **M3-24** | Nothing due           | Open one of the 30 quiet patients.                      | "No scheduled doses today" or "All doses answered" — **never a blank row**.                          | A blank row reads as "nothing to give".                                                                  |
| **M3-25** | Pagination is visible | 42 patients at page size 20.                            | The footer says there are more pages rather than ending silently.                                    | **A nurse reading "2 doses due" off page one of three and stopping is the failure this row exists for.** |
| **M3-26** | Later dose selectable | On a TDS patient, select the **14:00** dose, not 08:00. | The confirmation names the dose you picked.                                                          | Charting the wrong slot.                                                                                 |
| **M3-27** | Screen reader         | TalkBack/VoiceOver through a dose row.                  | Announces patient, then drug, dose, route, time, state. **Colour alone must never carry "overdue".** | Accessibility + safety.                                                                                  |

### H–K. Administering: Give / Hold / Refused

| ID        | Purpose            | Steps                               | Expected                                                                              | Concern                                                   |
| --------- | ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **M3-28** | Confirmation order | Tap a due dose.                     | Names the **patient FIRST**, then drug, dose, route, scheduled time.                  | Drug-first invites the wrong-patient error.               |
| **M3-29** | **Give**           | Confirm.                            | Returns to the round; the dose reads **Given, from the server** — not optimistically. | A local status flip that the server never saw.            |
| **M3-30** | **Hold**           | Choose Hold with no reason.         | Button stays **disabled until a reason is typed**.                                    | A blank in the MAR is a question nobody can answer later. |
| **M3-31** | **Refused**        | Choose Refused.                     | Records **without** a reason, but the reason field is offered anyway.                 | Forcing a reason on a refusal invents data.               |
| **M3-32** | Already answered   | Reopen a dose you already gave.     | **No Give button at all** — facts only.                                               | Re-offering Give is how a double dose happens.            |
| **M3-33** | `not_available`    | Look for a "not available" outcome. | The app **displays** the status but does not offer it. → §19, product decision.       | Not a defect. Record and move on.                         |

### L–N. Safety scenarios

→ **§8** (duplicate, concurrent) and **§10** (lost response). They are the reason the app was built
this way and they get their own sections.

### Q–T. Branch, timezone, permissions, staleness

| ID        | Purpose                   | Steps                                                                   | Expected                                                                                                                                                                   | Concern                                                                                       |
| --------- | ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **M3-34** | Round follows branch      | Switch to branch B.                                                     | Round shows **Annexe Ward**; the ward picker offers B's wards.                                                                                                             | → §11.                                                                                        |
| **M3-35** | Stale row is safe         | Nurse A opens the round; **Nurse B gives a dose**; Nurse A taps it.     | Re-reads and shows **already answered**. Nurse A must **never** see an active Give. _(The S5A fix.)_                                                                       | This is the near-miss that duplicate protection exists to catch _before_ the database has to. |
| **M3-36** | Refetch on resume         | Background 1 min while the round is open; Nurse B gives a dose; resume. | The round refetches and shows the new state.                                                                                                                               |                                                                                               |
| **M3-37** | Advisory vs authoritative | Leave the round untouched in the foreground for 5 minutes.              | It **may legitimately show the older state** — the round is advisory, the confirmation screen is authoritative. **Confirm a stale tap still lands on "already answered".** | Do not report the stale list itself as a defect.                                              |

---

## 8. MAR SAFETY — DUPLICATE AND CONCURRENT ADMINISTRATION

**The most important section in this runbook.** Neither test can be simulated honestly and neither can
be run alone.

### 8.1 Two mechanisms, and they are not the same thing

This distinction decides how you classify what you see. Getting it wrong produces a bug report that
sends someone to the wrong file.

|                         | **Database uniqueness**                                                                                               | **Idempotency-Key**                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Question it answers** | "Has _anyone_ already charted this dose slot?"                                                                        | "Have _I_ already sent _this exact request_?"                                               |
| **Identity**            | `tenantId + prescriptionId + lineIndex + scheduledFor`                                                                | `tenant + user + key`                                                                       |
| **Installed by**        | migration `0049-one-administration-per-dose-slot`                                                                     | migration `0048-idempotency-key-claims`                                                     |
| **Fires as**            | `409 HMS-MAR-001`, carrying `details.existing`                                                                        | `409 HMS-REQ-002` (same key, different body) · `409 HMS-REQ-004` (same key still in flight) |
| **Protects against**    | **Two different people**, or one person on two devices                                                                | **One client retrying** after a lost response                                               |
| **Scope**               | Scheduled doses only — **PRN (`SOS`) is deliberately unconstrained**, because a second as-required dose is legitimate | 24 h TTL; 60 s claim timeout                                                                |

**A PRN dose given twice is not a defect.** If you test duplication on the SOS line, both will
succeed, and that is correct. Use a **scheduled** dose.

### MAR-01 · Duplicate — same nurse, second attempt

|                    |                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**        | The second attempt on an already-charted dose is answered, not merely rejected.                                                                                                                    |
| **Precondition**   | ENV-04 READY. A scheduled dose already charted by Nurse A (M3-29).                                                                                                                                 |
| **Role / Surface** | Nurse A · phone                                                                                                                                                                                    |
| **Steps**          | Reopen the same dose. Attempt to give it again by any route the UI still offers (if none is offered, that is M3-32 passing — record it and use the API step below to confirm the server's answer). |
| **Expected**       | `409 HMS-MAR-001`. The UI says **"already given"**, names **who** and **when**, and **offers no retry**. A generic error is a FAIL.                                                                |
| **Evidence**       | Screenshot of the message; network capture of the 409 including `details.existing`; MAR row count.                                                                                                 |
| **Concern**        | A retry button here is a P1 — it invites the exact action the constraint exists to prevent.                                                                                                        |

### MAR-02 · Concurrent — two nurses, two devices, one dose

|                    |                                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**        | The real race. Two people reaching for the same dose at the same moment.                                                                                                                            |
| **Precondition**   | ENV-04 READY. **Two devices.** Nurse A signed in on one, **Nurse B on the other**. A **scheduled** dose that is due and unanswered. Note the patient, bed, drug and scheduled time before starting. |
| **Role / Surface** | Nurse A + Nurse B · two phones (or one phone + web signed in as Nurse B)                                                                                                                            |
| **Steps**          | 1. Both open the **same** dose confirmation screen. 2. Confirm both screens show the same patient, drug, dose and scheduled time. 3. On a count of three, both press **Give**.                      |
| **Expected**       | **Exactly one succeeds.** The other receives `409 HMS-MAR-001` and is told the dose is already given, by whom and when, **with no retry offered**. Neither nurse sees a generic error.              |
| **Evidence**       | **Both** screens photographed. Both network responses. The MAR row count (below). Both nurses' identities and the timestamps.                                                                       |
| **Concern**        | **Two successes is a P0.** Stop immediately, capture everything, and check ENV-04 before concluding — this exact symptom was produced on 2026-08-14 by a _missing index_, not a code defect.        |

### MAR-03 · Verify the server, not the screen

The UI's claim is not the evidence. Confirm the database.

```bash
# Mongo is on port 37018 in this dev environment.
mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
  db.medicationAdministrations.find(
    { prescriptionId: "<PRESCRIPTION_ID>", lineIndex: <N>, scheduledFor: "<ISO>" },
    { administeredBy: 1, status: 1, administeredAt: 1, branchId: 1 }
  ).toArray()'
```

**Expected: exactly one document.** Also confirm the constraint is present and armed:

```bash
mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
  db.medicationAdministrations.getIndexes().filter(i => i.unique)'
```

**Expected:** a unique index on `{tenantId, prescriptionId, lineIndex, scheduledFor}` with
`partialFilterExpression: { scheduledFor: { $exists: true } }`.

> If that index is absent, **every result in this section is void** — re-run ENV-03 and ENV-04 and
> start §8 again before writing a defect report. This is not a hypothetical caution; it happened.

### MAR-04 · PRN is deliberately different

|                  |                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Purpose**      | Confirm the partial filter, by observing that a _legitimate_ second dose is allowed.                                                                                           |
| **Precondition** | The seeded "same drug scheduled + SOS" patient.                                                                                                                                |
| **Steps**        | Give the **SOS** line. Then give it again.                                                                                                                                     |
| **Expected**     | **Both succeed.** An as-required drug may be given more than once.                                                                                                             |
| **Concern**      | If the second is refused, the partial filter is wrong and the constraint is now _causing_ harm by blocking real care. Report as P1 — this is worse than the defect 0049 fixes. |

### MAR-05 · Line identity is a position

|              |                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**  | `lineIndex` identity, on the 3-line prescription (Metformin / Amlodipine / Cetirizine).                                     |
| **Steps**    | Give **line 1** (Amlodipine 5 mg) at its scheduled time. Then open **line 0** (Metformin) at its own time.                  |
| **Expected** | Line 0 is still givable. Charting one line does not answer another.                                                         |
| **Concern**  | If giving one line marks another answered, dose identity is keyed on the drug rather than the position — a P0-class defect. |

---

## 9. THE FIVE RIGHTS

**This section is not a UI review.** Each of the five is a field a nurse legally relies on before
putting a drug into a person.

> **A blank patient name, a missing UHID, or an ambiguous dose is a SAFETY CONCERN, not a cosmetic
> defect.** If any of the five is missing or ambiguous on a real screen, **stop that scenario and
> report it** — do not finish the round and mention it later.

### FR-01 · The five, on every administering surface

Run once on **mobile** and once on **web**, on the confirmation screen — the screen a nurse reads at
the moment of giving.

| #   | Right                | Where it must appear       | Expected                                                                        |
| --- | -------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| 1   | **Right patient**    | Named **first**, with UHID | Full name and UHID, unambiguous, not truncated to uselessness                   |
| 2   | **Right medication** | Drug name                  | e.g. `Paracetamol 500mg Tablet` — the name from the **signed line**, not a code |
| 3   | **Right dose**       | Dose                       | e.g. `500 mg`                                                                   |
| 4   | **Right route**      | Route                      | `oral` for every seeded line                                                    |
| 5   | **Right time**       | Scheduled time             | In the **branch's** zone, e.g. `14:00` for the TDS middle dose                  |

**Evidence:** a photograph of the confirmation screen, plus the same five read back from
`GET /encounters/:id/medication-schedule` so screen and server can be compared field for field.

### FR-02 · The long-stay patient — web defect **D-1**

|                    |                                                                                                                                                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**        | The specific case that failed. The browser used to rebuild patient names client-side from `listPatients({ limit: 100 })`, so a patient admitted **before** the 100 most recent registrations had no name to find — and the medication confirmation read **"Patient: —"**. Right patient, blank. |
| **Precondition**   | ENV-04 confirms `long-stay patient outside the recent-100 window (D-1)` — e.g. **bed GW-1**. 127 patients registered in total, so the window genuinely excludes them.                                                                                                                           |
| **Role / Surface** | Nurse A · **web first** (this is where it broke), then mobile                                                                                                                                                                                                                                   |
| **Steps**          | 1. Open the medication round. 2. Find bed **GW-1**. 3. Read the row. 4. Select a dose and read the confirmation screen.                                                                                                                                                                         |
| **Expected**       | Name **and** UHID present on both the row and the confirmation. Resolved **server-side**.                                                                                                                                                                                                       |
| **Concern**        | `—`, `Patient: —`, a blank, or an id where a name belongs = **FAIL, safety**. Stop and report.                                                                                                                                                                                                  |
| **Note**           | Fixed in `375e4cf`; **the fix has never been seen in a browser.** That is precisely why this row exists.                                                                                                                                                                                        |

### FR-03 · Identity survives a long name

|              |                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Steps**    | Find or create (via the console, synthetic) a patient with a very long name; open the confirmation screen at largest OS text size. |
| **Expected** | Name wraps or truncates **with the UHID still visible**.                                                                           |
| **Concern**  | A truncated name with no UHID leaves nothing to identify the patient by.                                                           |

---

## 10. LOST-RESPONSE TESTING

**The dangerous case is not "the request failed".** It is: **the server committed successfully and the
client never heard back.** The client then knows only that it does not know. Everything in this
section tests what it does with that.

### 10.1 How to induce it

| Method                       | How                                                      | Good for                                                                                               |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Airplane mode mid-flight** | Tap the action, then toggle airplane mode within ~200 ms | Mobile. Most realistic. Hardest to time.                                                               |
| **Kill the API**             | `Ctrl-C` the API terminal the instant the request leaves | Both. Easiest to time; also kills the commit if you are too fast — check the DB to see which happened. |
| **Browser DevTools offline** | Network tab → Offline, toggled during the request        | Web. Most repeatable.                                                                                  |
| **Walk out of wifi range**   | Genuinely walk                                           | The real cellular handover case; do this **at least once** (M2-30 or LR-01).                           |

**Whichever you use, you must afterwards determine what the server actually did** — the test is
meaningless until you know whether the commit landed. Use the MAR-03 query.

### LR-01 · Lost MAR response

|                    |                                                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**        | The highest-stakes reconciliation in the product.                                                                                                                                                                                         |
| **Precondition**   | ENV-04 READY. A due, unanswered **scheduled** dose. Note prescription id, `lineIndex` and `scheduledFor` before you start.                                                                                                                |
| **Role / Surface** | Nurse A · phone                                                                                                                                                                                                                           |
| **Steps**          | 1. Open the dose, press **Give**. 2. Kill the network **during** the request. 3. Read what the app says. 4. Restore the network. 5. Press Give again / let the app reconcile. 6. Query the database.                                      |
| **Expected**       | **Step 3:** the app says it **could not confirm** — never "not saved", never "saved". **Step 5:** resolves to "already recorded, nothing was recorded twice" — _not_ a second dose, _not_ a blind retry. **Step 6: exactly one MAR row.** |
| **Evidence**       | Screenshot at step 3 **and** step 5; the network condition used; the exact timing; the MAR row count; the `Idempotency-Key` sent (both attempts must carry the **same** key).                                                             |
| **Concern**        | "Not saved" after a successful commit is a **P1** — it invites the nurse to give the drug again. A second MAR row is a **P0**.                                                                                                            |

### LR-02 · Retry with the held key replays

|              |                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**  | Distinguish idempotent replay from a fresh write.                                                                             |
| **Steps**    | After LR-01, retry with the **same** `Idempotency-Key`.                                                                       |
| **Expected** | The **same record id** is returned. No new row.                                                                               |
| **Concern**  | A new id means the key is not being honoured — reclassify as an **Idempotency-Key** failure (§8.1), not a uniqueness failure. |

### LR-03 · Same key, different body

|              |                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| **Steps**    | Reuse a spent `Idempotency-Key` with a **different** payload (a different dose). API-level; `curl` is fine. |
| **Expected** | `409 HMS-REQ-002`.                                                                                          |
| **Concern**  | Accepting it means one key can write two different clinical facts.                                          |

### LR-04 · Lost vitals response — web defect **D-2**

|                    |                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**        | Vitals writes were made idempotent and reconciled in `375e4cf`. **Never confirmed in a browser.**                                                   |
| **Precondition**   | A patient with no vitals yet (the seed deliberately creates none).                                                                                  |
| **Role / Surface** | Nurse A · **web first**, then mobile                                                                                                                |
| **Steps**          | 1. Record a full set of vitals; save. 2. Kill the network during the request. 3. Read the UI. 4. Restore. 5. Reconcile / retry. 6. Check the chart. |
| **Expected**       | Step 3: does **not** claim "Saved". Step 5: reconciles and reports what it found. Step 6: **exactly one** observation for that moment.              |
| **Concern**        | A duplicated observation is a corrupted clinical trend. A false "Saved" is worse — the nurse stops.                                                 |

### LR-05 · Legitimate repeat observations still work afterwards

|              |                                                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**  | The one that catches an over-correction. Reconciliation must not turn into "refuse anything that looks similar".                               |
| **Steps**    | After LR-04, record a **genuinely new** set of vitals for the same patient minutes later.                                                      |
| **Expected** | **Accepted, and both readings are kept.** Vitals carry no uniqueness constraint by design.                                                     |
| **Concern**  | Refusing a real second observation is a **P1 in the opposite direction** — a nurse who cannot record a deteriorating patient's second reading. |

### LR-06 · Backgrounded mid-save

|              |                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Steps**    | Start a save, immediately background the app.                                                                                                                      |
| **Expected** | The mutation is allowed to finish.                                                                                                                                 |
| **Concern**  | Cancelling in-flight is exactly the ambiguity `Idempotency-Key` exists to resolve; if the app cancels _and_ discards the key, it has created the ambiguity itself. |

---

## 11. BRANCH ISOLATION

### 11.1 What is branch-scoped and what is deliberately hospital-wide

**Know this before you report anything**, or you will file a bug against a design decision.

| Data                                   | Scope                                     | Why                                                                        |
| -------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- |
| Encounters, admissions, ward lists     | **Branch**                                | A stay happens at a site                                                   |
| Medication schedule, administrations   | **Branch**                                | A dose is given at a site                                                  |
| Nursing notes                          | **Branch**                                | "                                                                          |
| Patient identity lookup (`namesByIds`) | **Hospital-wide, deliberate**             | A name is not site-specific; used to render identity                       |
| **Allergies**                          | **Hospital-wide, deliberate**             | _"An allergy does not stop at a site boundary."_ Documented.               |
| **Vitals**                             | **Branch** — fixed 2026-08-16 (`bdc027f`) | Was the D1 exposure. BR-05 is now a REGRESSION check.                      |
| **Report files (the PDF itself)**      | **Branch** — fixed 2026-08-17 (`c02dd09`) | Was the D10 exposure. → **BR-10**                                          |
| **Appointment transitions**            | **Branch** — fixed 2026-08-17 (`4732dd8`) | Was the D9 cross-branch WRITE. → **BR-11**                                 |
| **Wallet balance and receipts**        | **Hospital-wide, deliberate**             | One advance purse per patient; an advance moves between sites. → **BR-12** |

### BR-01 · A → B, clinical surfaces

|              |                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Steps**    | As Nurse A at branch A, note the ward list, round, and a patient chart. Switch to branch B.                                                       |
| **Expected** | Ward becomes **Annexe Ward** with **3** patients. Round shows B's doses. **No row, name, bed or dose from branch A survives anywhere on screen.** |
| **Evidence** | Before/after screenshots of every list.                                                                                                           |
| **Concern**  | Any surviving A row is cross-branch **display** of PHI.                                                                                           |

### BR-02 · B → A, back again

|              |                                                                    |
| ------------ | ------------------------------------------------------------------ |
| **Expected** | Re-reads A's 42 patients. Not a cached frame; not a merge of both. |

### BR-03 · Cross-branch chart is refused

|              |                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| **Steps**    | While at branch B, navigate directly to a branch-A patient/encounter (deep link on mobile, URL on web). |
| **Expected** | "Not available here" / not-found. **It must not render.** Server returns `404 HMS-GEN-404`.             |
| **Concern**  | Rendering is a **P1**.                                                                                  |

### BR-04 · Cross-branch writes are refused

|              |                                                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Steps**    | While at branch B, attempt to POST a nursing note and a medication administration against a branch-**A** encounter. `curl` is the cleanest way. |
| **Expected** | Both refused, `404 HMS-GEN-404`.                                                                                                                |
| **Status**   | Already verified at the API on 2026-08-14. **Re-confirm through the UI** — this row is about whether the client can be talked into it.          |

### BR-05 · Cross-branch **vitals** — **D1 is FIXED; this is now a regression check**

|                         |                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**             | D1 was FIXED on 2026-08-16 (`bdc027f`). This row no longer confirms an exposure — it confirms the fix holds on a real device, and that the fix did not hide un-stamped historical readings. **Expect refusal, not rows.**                                                                            |
| **Precondition**        | A branch-A stay that has vitals (record some in M3-12 first).                                                                                                                                                                                                                                        |
| **Steps**               | 1. As Nurse A, switch to **branch B**. 2. Read the branch-A stay's vitals — via the chart if the UI reaches it, otherwise `GET /encounters/:id/vitals` with `X-Active-Branch` set to B. 3. On the same stay, also request medication-schedule, medication-administrations and notes.                 |
| **Expected (post-fix)** | Vitals now refuse the foreign visit like everything else — `403`/`404`, **not** 200-with-rows. Schedule, administrations and notes still return **0 rows**; chart and patient still `404`; all **writes** still refused. A **200 with rows is a REGRESSION** and is a P1 report, not a known defect. |
| **Evidence**            | The 200 with row count; the contrasting 0-row responses; whether the **UI** surfaces it or only the API does.                                                                                                                                                                                        |
| **Also check**          | On the patient TREND view, a reading taken at the other site must still appear — that read is hospital-wide on purpose (`forPatientAcrossBranches`). Losing it is the D1 fix over-applied, and is its own defect.                                                                                    |
| **Classification**      | Any failure here is a **new P1 regression**, not risk-register D1. D1 is closed.                                                                                                                                                                                                                     |

### BR-06 · Branch deactivated underneath you

|              |                                                                                       |
| ------------ | ------------------------------------------------------------------------------------- |
| **Steps**    | As tenant admin, deactivate the branch Nurse A is working in. Resume the nurse's app. |
| **Expected** | Falls back to a valid branch. Does not keep sending the dead one.                     |

### BR-07 · Branch-confined user — **BLOCKED**

|                    |                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**        | D1's blast radius. A user _bound_ to one branch, rather than a hospital-wide user with an active-branch header.                                                                                                                                                                                                                                                                                |
| **Status**         | **BLOCKED** — no branch-confined account exists. `assignRole(userId, roleId, branchIds)` sets `branchScope = "branches"` when `branchIds` is non-empty; both seeded nurses have it empty (hospital-wide).                                                                                                                                                                                      |
| **To unblock**     | Create a third synthetic nurse bound to branch B only, via the roles UI as tenant admin. **No code change needed.**                                                                                                                                                                                                                                                                            |
| **Why it matters** | Raised sharply by the 2026-08-17 audit. D1 is closed, but that audit found **three more** branch-scope defects (D9, D10, D11) in code that had passed review, and every one lived on a path no test walked with two branches configured. The confined user is the case with the least coverage in the entire product. Unblocking this is now the highest-value single account in the campaign. |

### BR-08 · Stale UI across a switch

|              |                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Steps**    | Open the round at A. Switch to B **without leaving the round**.                                                                                                                                         |
| **Expected** | The round repaints. On web, the routed subtree is _keyed_ on the branch scope, so it is discarded and reloaded; on mobile the query cache is cleared. **Never A's doses under B's name in the header.** |
| **Concern**  | Header says one site, data is another's — the original web defect this design exists to prevent.                                                                                                        |

### BR-09 · Unknown `X-Active-Branch` — known defect **D4**

|                      |                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Steps**            | API-level. Send garbage, a valid-but-not-a-branch ObjectId, and another tenant's branch id.                                                      |
| **Expected — today** | All return `200` with `total=45` (**all** sites) instead of 42 (branch A). The header is silently ignored.                                       |
| **Classification**   | **KNOWN DEFECT — D4, P3.** It **cannot exceed the caller's binding**, so it is a correctness issue, not an escalation. Record; do not re-report. |

### BR-10 · 🔴 Cross-branch **report file** — regression check for **D10**

Highest-value row in this section. D10 was a cross-branch PHI disclosure of the actual clinical
document, and the LIST was already scoped — so the UI never offered the link and the defect was
invisible to anyone clicking around. It has to be probed directly.

|                  |                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Precondition** | A lab or radiology order at branch **A** with a report uploaded against it (M6/web lab flow, or the order worklist). Note the report id from `GET /patients/:id/reports` **as an A user**.                                 |
| **Steps**        | 1. As a **branch-B** user holding `emr:read`, call `GET /api/v1/patients/:patientId/reports` — the id must **not** appear. 2. Then request `GET /api/v1/reports/:id/file` for the id you noted, with `X-Active-Branch: B`. |
| **Expected**     | Step 1 omits it. Step 2 refuses — `404 HMS-GEN-404`. **A `200` returning PDF bytes is a P1 regression.**                                                                                                                   |
| **Evidence**     | Both responses. For step 2 record the status and the first bytes (`%PDF` means it served the file).                                                                                                                        |
| **Also check**   | The A user can still open it. A refusal in **both** directions is the fix over-applied and is its own defect.                                                                                                              |
| **Why by hand**  | The automated test proves the API. This row proves that no client — a stale tab, a bookmarked link, a shared URL, a mobile deep link — can still reach the bytes.                                                          |

### BR-11 · 🔴 Cross-branch **appointment write** — regression check for **D9**

The only confirmed **write** across a branch boundary. A read leaking is bad; this changed another
site's clinic list.

|                  |                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Precondition** | An appointment booked at branch **A**, in `requested` or `confirmed`. Note its id.                                                                                                                   |
| **Steps**        | As a **branch-B** clerk holding `appointment:cancel` / `appointment:update`, POST each of `/cancel`, `/no-show`, `/check-in` against the branch-A appointment id, with `X-Active-Branch: B`.         |
| **Expected**     | All three refuse — `404 HMS-GEN-404`. **Then re-read the appointment as an A user: it must still be in the state it started in.**                                                                    |
| **Trap**         | Before the fix, the FIRST call succeeded (200, `cancelled`) and the next two returned **422** — refused by the state machine for being already cancelled. Do not read a 422 as the boundary working. |
| **Evidence**     | All three statuses **and** the appointment's state afterwards, read as an A user. The second half is what actually proves it.                                                                        |

### BR-12 · Wallet advance is hospital-wide — a **negative** check

Not every cross-branch read is a leak, and this row exists so nobody "fixes" one that is not. A
patient has ONE advance balance for the hospital; an advance taken at A is spendable at B.

|                    |                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Steps**          | Take an advance at branch **A**. As a **branch-B** cashier, open the patient's wallet, then reprint the receipt via `GET /api/v1/wallet/entries/:id`.             |
| **Expected**       | Balance and statement show the A deposit; the receipt reprints, `200`. **A refusal here is a defect**, not a security improvement.                                |
| **Why it is here** | During the 2026-08-17 audit this read was "fixed" to be branch-scoped and then reverted. The statement showing a line whose receipt will not open is the failure. |

---

## 12. TIMEZONE

Branch A `Asia/Kolkata` · Branch B `America/New_York` — **9½–10½ hours apart**, deliberately chosen so
the two wards are on different calendar days during ordinary working hours.

**The rule under test: clinical time is the BRANCH's, never the device's.**

| ID        | Purpose                   | Steps                                                                           | Expected                                                                               | Concern                                    |
| --------- | ------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| **TZ-01** | Device zone is irrelevant | Set the **phone** to `Pacific/Kiritimati`. Open the round at branch A.          | Dose times read in the **ward's** clock (08:00/14:00/20:00 for TDS). Unchanged.        | Device-derived times are clinically wrong. |
| **TZ-02** | Device midnight           | Near the **phone's** midnight but not the ward's.                               | The round still shows the **ward's** day. It must not roll over or empty.              | An emptied round mid-shift.                |
| **TZ-03** | Ward midnight             | Near the **ward's** midnight.                                                   | The round rolls to the new clinical day.                                               |                                            |
| **TZ-04** | Two wards, two days       | With A and B on different calendar dates, open the round at each.               | Each shows **its own** day. TDS lands 08:00/14:00/20:00 **on each ward's own clock**.  |                                            |
| **TZ-05** | Due / overdue             | Compare a dose's state against `--verify`'s overdue count and the branch clock. | State derives from the branch zone and `OVERDUE_AFTER_MS` (1 h). No client arithmetic. | Client-side due calculation.               |
| **TZ-06** | Switch mid-day-boundary   | Switch A → B while the two are on different dates.                              | Header, day label and doses all move together to B's day.                              | A mixed state is unreadable.               |
| **TZ-07** | Timestamps carry the zone | Read any recorded time (vitals, note, administration).                          | Carries the branch's zone label; does not move when the device zone changes.           |                                            |

### Known timezone defects — record, do not fix

| ID                     | Where              | Behaviour                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TZ-08 · GAP-1 / D2** | Reception register | `?date=` resolves in `env.DEFAULT_TIMEZONE`, not the branch's. `encounter.controller.ts:44` — its own comment says "the HOSPITAL's timezone", true when a hospital was one site. **Expected to be wrong.** Confirm the shape as Receptionist at branch B near a date boundary; record; do not fix. |
| **TZ-09 · GAP-2 / D3** | Bed-day billing    | `chargeBedDays` receives `branchId` and does not use it for the zone (`billing.consumers.ts:393`). Bed-days bill per calendar day started, so a stay at a differently-zoned site can be **one night out**. This is money. Confirm; record; do not fix.                                             |

---

## 13. WEB VALIDATION

Surface: Next.js app. **No web checklist existed before this runbook** — see §20. These are written
from the current implementation at `39e2dff`.

**URL:** `http://sunrise.localhost:3000`, or `http://sunrise.<lan-ip>.sslip.io:3000` if ENV-06 moved
`TENANT_BASE_DOMAIN`. **Navigation:** `Ward` → `/ward` (`emr:read`), `Medication round` →
`/medication-round` (`emr:read`).

> **Why `emr:read` and not `mar:administer` on the round:** a doctor or pharmacist reconciling what a
> patient actually received is a legitimate _reader_. The boundary that matters is on the **write**,
> which stays `mar:administer`. A viewer sees the round with its dose actions **inert** — that is
> WEB-19, and it is correct behaviour, not a permission leak.

| ID         | Purpose                     | Role        | Steps                                                         | Expected                                                                                                                                                                              | Concern                                                                                                                                                                                                 |
| ---------- | --------------------------- | ----------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WEB-01** | Login                       | Nurse A     | Sign in at the tenant host.                                   | Reaches the app; nav shows Ward and Medication round.                                                                                                                                 | Missing nav = permission mapping broken.                                                                                                                                                                |
| **WEB-02** | Wrong host                  | —           | Browse a slug that does not exist.                            | _"This address does not belong to any hospital"_ — the URL, not the password. **On load**, before a password is typed.                                                                | **DECIDED 2026-08-18 — product changed to match.** The public branding call already knew; it now says so. `AUTOMATED — PLAYWRIGHT`.                                                                     |
| **WEB-03** | Ward page                   | Nurse A     | Open `/ward`.                                                 | Admitted patients for branch A with beds.                                                                                                                                             |                                                                                                                                                                                                         |
| **WEB-04** | Ward identity               | Nurse A     | Read rows.                                                    | Name on every ward row; **name + UHID together on every ADMINISTERING surface** — the medication round row and its confirmation (§9 FR-01), and the patient chart the ward row opens. | **AMENDED 2026-08-18.** Was "Name + UHID on every row" of `/ward`, which is stricter than the §9 rule it points at: no drug can be given from a ward list. Product unchanged. `AUTOMATED — PLAYWRIGHT`. |
| **WEB-05** | **Long-stay patient (D-1)** | Nurse A     | Find bed **GW-1** on `/ward` and `/medication-round`.         | Name and UHID present, resolved server-side.                                                                                                                                          | **`Patient: —` = FAIL, safety.** The exact regression `375e4cf` fixed and nobody has since seen in a browser.                                                                                           |
| **WEB-06** | Round loads                 | Nurse A     | Open `/medication-round`.                                     | _"Every dose expected on the ward today, earliest outstanding first."_ Rows carry name, UHID, bed.                                                                                    |                                                                                                                                                                                                         |
| **WEB-07** | Five rights                 | Nurse A     | Select a dose.                                                | Name · UHID · bed · drug · **dose · route** · scheduled time.                                                                                                                         | → §9. Missing field = stop.                                                                                                                                                                             |
| **WEB-08** | Pagination is honest        | Nurse A     | 42 patients, page size 20.                                    | The footer states there are more pages.                                                                                                                                               | _"A nurse reading '2 doses due' off page one of three and stopping"_ is the failure this guards.                                                                                                        |
| **WEB-09** | Answered doses stay visible | Nurse A     | Open a patient whose doses are all answered.                  | Shows the given/held/refused doses — **not** "All doses answered" _instead of_ them.                                                                                                  | Hiding answered doses hides the record; this was a real defect.                                                                                                                                         |
| **WEB-10** | Nothing due                 | Nurse A     | Open a quiet patient.                                         | An explicit empty state, never a blank row.                                                                                                                                           |                                                                                                                                                                                                         |
| **WEB-11** | Later dose                  | Nurse A     | On a TDS patient select **14:00**.                            | The confirmation names the dose selected.                                                                                                                                             | Charting the wrong slot.                                                                                                                                                                                |
| **WEB-12** | **Give**                    | Nurse A     | Confirm.                                                      | Server-authoritative "Given".                                                                                                                                                         | Optimistic local flip.                                                                                                                                                                                  |
| **WEB-13** | **Hold**                    | Nurse A     | Hold with no reason.                                          | Refused until a reason is given.                                                                                                                                                      | A blank in the MAR.                                                                                                                                                                                     |
| **WEB-14** | **Refused**                 | Nurse A     | Refuse.                                                       | Records without a reason; reason offered.                                                                                                                                             |                                                                                                                                                                                                         |
| **WEB-15** | Duplicate                   | Nurse A     | Re-attempt the same dose.                                     | `409 HMS-MAR-001` read as an **answer**: "already given", by whom, when, **no retry**.                                                                                                | _"Not saved — try again"_ here would be the pre-W3 behaviour returning.                                                                                                                                 |
| **WEB-16** | Concurrency                 | Nurse A + B | → **MAR-02**, using web as one of the two sessions.           | Exactly one succeeds.                                                                                                                                                                 |                                                                                                                                                                                                         |
| **WEB-17** | Lost MAR response           | Nurse A     | DevTools → Offline during Give. → **LR-01**.                  | Reconciles; exactly one row.                                                                                                                                                          |                                                                                                                                                                                                         |
| **WEB-18** | Vitals + lost response      | Nurse A     | Record vitals, then → **LR-04**, then **LR-05**.              | One observation; a later genuine reading still accepted.                                                                                                                              |                                                                                                                                                                                                         |
| **WEB-19** | Viewer sees inert actions   | **Doctor**  | Open `/medication-round`.                                     | The round **renders** (`emr:read`); dose actions are **inert**.                                                                                                                       | Correct. Not a leak. If a doctor can actually chart, that is a P1.                                                                                                                                      |
| **WEB-20** | Branch switch               | Nurse A     | Switch A → B → A on the round.                                | Subtree discarded and reloaded each time; no stale rows; header and data always agree.                                                                                                | → BR-08.                                                                                                                                                                                                |
| **WEB-21** | Timezone                    | Nurse A     | → TZ-01/TZ-04 in the browser; change the **OS** timezone.     | Times stay in the branch's zone.                                                                                                                                                      |                                                                                                                                                                                                         |
| **WEB-22** | Tablet / narrow             | Nurse A     | 768px and 1024px widths.                                      | Round and confirmation usable; identity line never clipped.                                                                                                                           | A clipped identity line is a §9 failure at any width.                                                                                                                                                   |
| **WEB-23** | Accessibility               | Nurse A     | Keyboard-only through the round; screen reader on a dose row. | Every action reachable by keyboard with a visible focus state; the row announces patient → drug → dose → route → time → state. **Colour alone must not carry "overdue".**             |                                                                                                                                                                                                         |
| **WEB-24** | Session expiry              | Nurse A     | Revoke the session server-side; act.                          | Explicit re-authentication, not a silent failure.                                                                                                                                     |                                                                                                                                                                                                         |

---

## 13A. THE CLINICAL JOURNEY, END TO END — added 2026-08-17

### Why this section exists

**§13 covers two web pages out of forty-four.** `/ward` and `/medication-round` are the nursing
slice, and everything above was written around the MAR because that is where the safety argument
lives. But this runbook's own §1 says it validates "the Next.js web app", and until now a patient
could not be followed from the front desk to the bill through any row in it. Registration,
reception, appointments, ordering, dispensing, admission, bed transfer, discharge and billing had
**no test row at all** — they appeared only where they happened to intersect a safety control (a
timezone defect, a drift refusal, a permission denial).

That is a coverage gap, not a scope decision, so it is closed here rather than declared. **These
rows are written from the implementation on 2026-08-17 and none has been executed.**

> **Run this section AFTER §5.0 and §15, and BEFORE the mobile sections.** It is one continuous
> patient, so a failure early on blocks the rest — which is the point: it is the only place in this
> document where the failure of one step is allowed to prevent the next.

### The journey

One synthetic patient, front desk to bill. **Tenant `sunrise`, branch A (Main Branch)** throughout.
Where a row needs a different login than the previous one, the role column says so — the handover
between people _is_ part of what is being tested.

| ID        | Step                             | Who                                | Action                                                                                | Expected                                                                                                                              | Concern                                                                                                                                                  |
| --------- | -------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JR-01** | Register a new patient           | Receptionist                       | `/patients` → register a synthetic patient with a name and phone.                     | `201`. A **UHID** is issued and shown.                                                                                                | No UHID on screen = the identity the whole record hangs from is invisible at the moment it is created.                                                   |
| **JR-02** | **MPI duplicate refusal**        | Receptionist                       | Register a **second** patient with the same name, DOB and phone.                      | `409 HMS-PAT-002`, and the screen **names the candidate(s)** it thinks this already is, with what matched.                            | A silent second UHID is how one human becomes two charts. **This is a safety row, not a validation row.**                                                |
| **JR-03** | Deliberate override              | Receptionist                       | On that refusal, choose to register anyway (`force`).                                 | Proceeds, and only because a human said so.                                                                                           | If `force` is applied automatically anywhere, that is a **P1** — the check would be decorative.                                                          |
| **JR-04** | Patient lookup                   | Receptionist                       | Search by name, then by UHID, then by phone.                                          | All three find the patient.                                                                                                           |                                                                                                                                                          |
| **JR-05** | **Start a visit**                | Receptionist                       | `/reception` → start a visit for JR-01's patient.                                     | `201`; a **token** is issued; the patient appears on the day's register.                                                              |                                                                                                                                                          |
| **JR-06** | 🔴 **Start it again**            | Receptionist                       | Start a visit for the **same patient** a second time.                                 | The **same** visit is handed back — **resumed, not duplicated**. The register shows **one** row, one token.                           | Two open visits is _"the commonest data-quality disaster in an OPD"_ (§14 of the state-machine catalogue): the census double-counts and the bill splits. |
| **JR-07** | Appointment → the same door      | Receptionist                       | `/appointments` → book, then **check in**.                                            | Check-in produces a visit exactly as JR-05 did, and JR-06's rule still holds against it.                                              | Check-in reaches the same `startEncounter`. If it can create a second open visit, JR-06's guard has a hole.                                              |
| **JR-08** | Consultation                     | **Doctor**                         | `/my-patients` → call the token in, record the consultation.                          | Saved against **that** encounter; the queue advances.                                                                                 |                                                                                                                                                          |
| **JR-09** | Order an investigation           | **Doctor**                         | Order a lab test from the consultation.                                               | `201`; it appears on the **lab's** worklist without any hand-off.                                                                     | If it does not reach the lab queue, ADR-0013 §3's single-spine claim is not true in the product.                                                         |
| **JR-10** | Perform, verify, release         | **Lab tech**, then **Pathologist** | Accept → start → complete as the technician; **verify → release as the pathologist.** | The technician **cannot** verify. Only after `released` does the result reach the ordering doctor.                                    | Same person doing both is a patient-safety failure, not a shortcut. Two logins required.                                                                 |
| **JR-11** | Prescribe and sign               | **Doctor**                         | Prescribe one of the seeded drugs; sign.                                              | An allergy or interaction finding presents as a **review step**, not a failed save (→ M2-29).                                         | An alert shaped like an error gets clicked past.                                                                                                         |
| **JR-12** | Dispense                         | **Pharmacist**                     | `/pharmacy` → hand over against that prescription.                                    | `201`; `dispensedQty` rises; the drug charge appears on the bill **shortly after**, not instantly (billing listens for the event).    | A charge that never arrives is money the hospital loses silently.                                                                                        |
| **JR-13** | Admit                            | **Doctor**                         | `/my-patients` → admit to a free bed in **General Ward**.                             | `201`. The OP visit becomes **`admitted`** (terminal) and an **IP** encounter opens in the same episode. The patient is on `/ward`.   | If the OP visit is still `open`, the two-encounter transaction did not hold.                                                                             |
| **JR-14** | 🔴 **Occupied bed**              | **Doctor**                         | Admit a second synthetic patient to the bed JR-13 just filled.                        | **`409 HMS-STATE-001`** — _"That bed is already occupied"_, naming ward and bed.                                                      | Two patients in one bed is the classic HIS bug. A `201` here is a **P1**. (→ STATE_MACHINE_CATALOG §3.)                                                  |
| **JR-15** | Move bed                         | **Nurse A**                        | `/ward` → "Move bed" to a free bed.                                                   | `200`; the board shows the new bed and the old one is free. **The stay tariff does not change.**                                      | Different permission from JR-13 (`bed:allocate`, not `admission:create`) — a `403` means wrong login.                                                    |
| **JR-16** | Move onto a taken bed            | **Nurse A**                        | Move to the bed another patient is in.                                                | **`409 HMS-STATE-001`**, same refusal as JR-14.                                                                                       | The transfer path must be guarded by the same rule as admission, not merely the admit path.                                                              |
| **JR-17** | Vitals, notes, doses on the stay | **Nurse A**                        | Record vitals, a nursing note, and give a due dose against the IP encounter.          | All succeed and attach to the **IP** encounter, not the closed OP one.                                                                | Clinical writes landing on the closed outpatient visit would be invisible on the ward.                                                                   |
| **JR-18** | Discharge                        | **Doctor**                         | Discharge the patient with a discharge summary.                                       | `201`. The stay closes; the bed is free on `/ward`.                                                                                   | `admission:discharge` is DOCTOR-only and deliberately not the nurse's.                                                                                   |
| **JR-19** | 🔴 **A second summary**          | **Doctor**                         | Attempt a second discharge summary on the same stay.                                  | Refused — **exactly one** per admission.                                                                                              | _"A stay ends with two summaries and nothing says which one was sent to the patient."_                                                                   |
| **JR-20** | Bed-days                         | **Cashier**                        | `/billing` → look at the stay's charges.                                              | **One charge per calendar day started, minimum one** — admitted 22:00 and discharged 09:00 is **two** days, in the branch's timezone. | → TZ-09. This is money, and it was a real defect.                                                                                                        |
| **JR-21** | Finalize and pay                 | **Cashier**                        | Finalize the bill; take a payment.                                                    | The invoice totals the consultation, the drugs, the investigation and the bed-days. Payment recorded; a receipt is available.         | A finalized bill missing the drugs means JR-12's event never landed.                                                                                     |
| **JR-22** | The record afterwards            | **Doctor**                         | Re-open the patient.                                                                  | One patient, one episode, both encounters, the whole story in order.                                                                  | If the journey reads as two unrelated patients, JR-02 or JR-06 failed and was not noticed.                                                               |

### Safety scenarios this section adds

Three controls that had no row anywhere in this runbook. **Each is a positive control** — the
mechanism is present and must be seen refusing, which is different from §16A, where the mechanism
has been removed.

| ID         | Test                        | Who        | Steps                                                                                                                         | Expected                                                                                                                                                                               |
| ---------- | --------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DUP-01** | **Duplicate dispensing**    | Pharmacist | On JR-12's handover, **double-click** the dispense button. Then repeat with DevTools throttled to 3G.                         | **One** `dispenses` row. **`200` with `duplicate: true`, NOT a `409`** — the second attempt answers with the FIRST handover. `dispensedQty` rises **once**; stock decrements **once**. |
| **DUP-02** | **Duplicate order**         | Doctor     | On JR-09, double-click the order button.                                                                                      | **One** `orders` row, one work item on the lab queue. Again **`200` + `duplicate: true`**, and the screen says _already ordered_ rather than reporting a second test.                  |
| **TEN-01** | **Second-tenant isolation** | Any        | Log in to **`district`**. Search for the `sunrise` patient by name and by UHID. Then try `sunrise`'s ids directly at the API. | **Nothing is found, and nothing is served.** Different database entirely (ADR-0005). Any leak is a **P0 — stop the campaign and report immediately.**                                  |

> **Why DUP-01 and DUP-02 expect `200` and not `409`.** The MAR answers a repeated dose with
> `409 HMS-MAR-001` because charting the same slot twice is a clinical contradiction that a human
> must see. A repeated **dispense or order** is almost always a double-click or a retry, so the
> server returns the original row and says so — the drugs are handed over once and the patient is
> told once. **A `409` here would be a defect in the opposite direction**, and a tester expecting
> MAR's shape would report the correct behaviour as broken. Verify by counting rows, not by
> reading the status code.

### Known limitation this section will meet

**A patient registered at branch B cannot be opened from branch A**, though the MPI will offer them
as a search candidate. That is recorded technical debt (PROJECT_MEMORY §5; pinned by
`branchIsolation.int.test.ts` §18) and a **PRODUCT DECISION**, not a defect to raise: ADR-0015 §5
says patient lookup is tenant-wide, the repository scopes it to a branch, and doing neither is the
only certainly-wrong option. **Record it against this note and move on.** Do not attempt JR-01…JR-22
across two branches — run the whole journey at branch A.

---

## 14. NETWORK MATRIX

| ID         | Scenario                       | How                                                        | Mandatory?                  | Expected                                                                                                                     |
| ---------- | ------------------------------ | ---------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **NET-01** | Normal wifi                    | —                                                          | **Mandatory**               | Baseline for everything else                                                                                                 |
| **NET-02** | Airplane mode, read screen     | Toggle                                                     | **Mandatory**               | Explained offline state with retry — never a blank page                                                                      |
| **NET-03** | Airplane mode, write screen    | Toggle                                                     | **Mandatory**               | Save disabled **with a reason**; nothing claims success                                                                      |
| **NET-04** | Server unreachable, network up | Stop the API, leave wifi on                                | **Mandatory**               | _"Cannot reach the hospital's system"_, **not** "no internet". These are genuinely different and the app distinguishes them. |
| **NET-05** | Request interrupted mid-flight | → §10                                                      | **Mandatory**               | Reconciliation, never a blind retry                                                                                          |
| **NET-06** | Slow network                   | Network Link Conditioner / throttled hotspot / DevTools 3G | **Mandatory**               | Loading states appear **and resolve**; no screen sits blank                                                                  |
| **NET-07** | Reconnect                      | Restore after NET-02                                       | **Mandatory**               | Queries refetch on reconnect **without** a manual pull                                                                       |
| **NET-08** | Cellular handover              | Walk out of wifi range mid-save                            | Optional but **do it once** | The real-world version of NET-05; the only one that tests a genuine radio transition                                         |
| **NET-09** | Backgrounded during save       | → LR-06                                                    | Optional                    | The mutation completes                                                                                                       |

---

## 15. PERMISSION MATRIX

> **Constitution §3.6: "Every route enforces authn + permission + tenant scope server-side. UI gating
> is convenience, not security."** So every row here is verified **at the API**. A hidden button is
> not evidence; a `403` is. Where a UI check is also listed, it is a second, weaker observation.

### 15.1 Role × operation

| Operation                  | Route                                             | Permission         | NURSE | DOCTOR | RECEPTIONIST |     TENANT_ADMIN     |
| -------------------------- | ------------------------------------------------- | ------------------ | :---: | :----: | :----------: | :------------------: |
| Read medication schedule   | `GET /encounters/:id/medication-schedule`         | `emr:read`         |  ✅   |   ✅   |      ❌      |   _by role config_   |
| Read administrations       | `GET /encounters/:id/medication-administrations`  | `emr:read`         |  ✅   |   ✅   |      ❌      |   _by role config_   |
| **Administer a dose**      | `POST /encounters/:id/medication-administrations` | `mar:administer`   |  ✅   |   ❌   |      ❌      |          ❌          |
| Medication round           | `GET /medication-round`                           | `emr:read`         |  ✅   |   ✅   |      ❌      |   _by role config_   |
| Record vitals              | `POST /encounters/:id/vitals`                     | `vitals:record`    |  ✅   |   ✅   |      ❌      |          ❌          |
| **Nursing note**           | `POST /encounters/:id/nursing-notes`              | `nursing:manage`   |  ✅   |   ❌   |      ❌      |          ❌          |
| **Doctor's clinical note** | `POST /encounters/:id/notes`                      | `emr:write`        |  ❌   |   ✅   |      ❌      |          ❌          |
| Read patient               | `GET /patients/:id`                               | `patient:read`     |  ✅   |   ✅   |      ✅      |          ✅          |
| Register patient           | `POST /patients`                                  | `patient:register` |  ❌   |   ❌   |      ✅      |          ✅          |
| Close an encounter         | —                                                 | `encounter:close`  |  ❌   |   ✅   |      ❌      |   _by role config_   |
| Manage allergies           | —                                                 | `allergy:manage`   |  ✅   |   ✅   |      ❌      |          ❌          |
| Change plan                | —                                                 | `plan:manage`      |  ❌   |   ❌   |      ❌      | ❌ **operator only** |

_by role config_ — TENANT_ADMIN's clinical reach is a per-hospital configuration. **Verify against
the seeded role rather than assuming**, and mark `PRODUCT DECISION REQUIRED` if the repository does
not state the intent.

**Expected refusal:** `403` with `HMS-AUTH-005`. **Expected refusal for a resource outside scope:**
`404` with `HMS-GEN-404` (a 404 rather than a 403 is deliberate — a 403 would confirm the record
exists).

### 15.2 Tests

| ID          | Test                                                        | Expected                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PERM-01** | Doctor attempts to administer a dose                        | `403 HMS-AUTH-005`                                                                                                                                                         |
| **PERM-02** | Receptionist attempts to administer a dose                  | `403 HMS-AUTH-005`                                                                                                                                                         |
| **PERM-03** | Receptionist attempts to read a medication schedule         | `403 HMS-AUTH-005`                                                                                                                                                         |
| **PERM-04** | Nurse writes a **nursing note**                             | `201`                                                                                                                                                                      |
| **PERM-05** | Nurse attempts the **doctor's clinical note** (`emr:write`) | `403 HMS-AUTH-005`. **The nurse must have a working note route of her own (PERM-04) _and_ be refused this one.** Either half alone is the wrong outcome.                   |
| **PERM-06** | Nurse records vitals                                        | `201`                                                                                                                                                                      |
| **PERM-07** | Nurse attempts to close an encounter                        | `403` — closing freezes what can be billed and asserts the consultation happened                                                                                           |
| **PERM-08** | Every denial's **UI** shape                                 | An explanation, not a dead button and not a raw error                                                                                                                      |
| **PERM-09** | Doctor opens `/medication-round` on web                     | Renders; **actions inert** (WEB-19)                                                                                                                                        |
| **PERM-10** | Permission held by nobody                                   | For each permission in the matrix, confirm **some seeded role holds it**. A permission granted to no one is a feature nobody has — a recurring bug class in this codebase. |

### 15.3 API-level template

```bash
BASE=http://sunrise.localhost:4000        # or the sslip host from ENV-06
TOKEN=$(curl -s "$BASE/api/v1/auth/login" -X POST -H 'Content-Type: application/json' \
  -d '{"email":"drrao@sunrise.test","password":"123456"}' | jq -r '.data.accessToken')

curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/v1/encounters/<ID>/medication-administrations" \
  -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Active-Branch: <BRANCH_A_ID>' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"prescriptionId":"<RX>","lineIndex":0,"scheduledFor":"<ISO>","status":"given"}'
# expect 403
```

> **Node's `fetch` (undici) forbids setting a `Host` header.** If you script this in Node rather than
> `curl`, use the tenant **subdomain in the URL** — otherwise you will get a 404 and think the route
> is missing.

---

## 16. NEGATIVE / FALSIFICATION TESTS

**A runbook that only proves happy paths proves very little.** Each row attempts something that
should be refused and verifies the refusal. **None of them requires performing an unsafe clinical
action** — you attempt, and you observe the rejection.

| ID         | Attempt                                                                                | Expected                                                                                      | Notes                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **NEG-01** | Wrong role administers a dose                                                          | `403 HMS-AUTH-005`                                                                            | → PERM-01/02                                                                                                                   |
| **NEG-02** | Write to a **branch-B** encounter while scoped to A                                    | `404 HMS-GEN-404`                                                                             | → BR-04                                                                                                                        |
| **NEG-03** | **Duplicate scheduled dose**                                                           | `409 HMS-MAR-001` with `details.existing`; **exactly one row**                                | → MAR-01/02. Uses a _synthetic_ patient and the _correct_ drug — this proves the control without ever charting anything wrong. |
| **NEG-04** | Act on a **stale screen**                                                              | Re-read shows "already answered"; no active Give                                              | → M3-35                                                                                                                        |
| **NEG-05** | **Lost response**, then retry                                                          | Reconciled; one row                                                                           | → LR-01                                                                                                                        |
| **NEG-06** | Chart against the **wrong prescription line**                                          | Refused / charted against the line actually selected — never silently applied to another line | → MAR-05                                                                                                                       |
| **NEG-07** | Chart a dose slot **not on the schedule** (fabricated `scheduledFor`)                  | Refused                                                                                       | API-level                                                                                                                      |
| **NEG-08** | Chart against a **draft or cancelled** prescription                                    | Refused — the Rx must be in force                                                             | API-level                                                                                                                      |
| **NEG-09** | **Switch branch mid-workflow** — open a dose confirmation, switch branch, then confirm | The action does not complete against the old branch under the new branch's header             | The most likely place for a real cross-branch write                                                                            |
| **NEG-10** | **Expired session** mid-write                                                          | Explicit re-authentication; the write does not silently vanish                                | → M2-09                                                                                                                        |
| **NEG-11** | **Network interruption** mid-write                                                     | → §10                                                                                         |                                                                                                                                |
| **NEG-12** | Reuse an `Idempotency-Key` with a different body                                       | `409 HMS-REQ-002`                                                                             | → LR-03                                                                                                                        |
| **NEG-13** | Double-click a submit                                                                  | `409 HMS-REQ-004` (in flight) or one clean result — **never two records**                     |                                                                                                                                |
| **NEG-14** | Unknown `X-Active-Branch`                                                              | Known defect **D4** — widens the read to all sites                                            | → BR-09. Record, do not re-report.                                                                                             |

---

## 16A. CLINICAL SCHEMA REFUSAL — the 503 nobody has ever seen in the field

Five clinical writes now refuse when the database cannot enforce the rule they rest on. These are
the only errors in the product a **clinician** is expected to act on procedurally — they say _chart
on paper_, _hand over on paper_, _order on paper_, _allocate on the board_, _register on paper_ —
so they need to be seen by a real person on a real screen at least once before a pilot.

### Setting it up, and putting it back

You are dropping a real index on a real tenant. **Use the validation ward tenant only**, and put it
back inside the same session. `forgetSchemaReadiness` is not reachable from outside the process, so
the 60-second cache means a repair can take up to a minute to become visible — that wait is itself
part of DRIFT-06.

```bash
# DROP (one of). Mongo is on port 37018 in this dev environment.
mongosh "mongodb://localhost:37018/hms_<slug>" --quiet --eval '
  db.medicationAdministrations.dropIndex("one_administration_per_dose_slot")'  # MAR
  # db.dispenses.dropIndex("one_dispense_per_request_id")                      # dispensing
  # db.orders.dropIndex("one_order_per_request_id")                            # ordering
  # db.encounters.dropIndex("one_open_stay_per_bed_per_branch")                # bed assignment
  # db.encounters.dropIndex("one_open_encounter_per_patient")                  # starting a visit
```

#### ⚠️ Restoring: the obvious command does NOT work, and it fails silently

> **`pnpm seed:migrate` will NOT put a dropped index back.** The runner skips any migration already
> listed in the tenant's `migrations` collection (`runner.ts` — `pending = migrations.filter(m => !done.has(m.id))`),
> and dropping an index does not remove its record. So the migration is skipped, the CLI reports
> **"tenant converged"**, and the database is exactly as unsafe as it was. This is measured, not
> theorised: `seed/schemaGuard.ts` records it against a real tenant on 2026-08-14 —
> `migrationsApplied: []`, index still absent. It is the `schema_drift` case in
> [`DEPLOYMENT_GATE.md`](DEPLOYMENT_GATE.md), and it is the single easiest way to end a validation
> session having quietly disarmed a ward.
>
> _(An earlier version of this runbook said to restore with `pnpm seed:migrate -- --tenant <slug>`.
> That is wrong twice: `--tenant` is not a flag the CLI parses — it accepts `--slug`, `--all`,
> `--check`, `--json` — so the command exits 1 with a usage error; and the `--slug` form a reader
> would then reach for restores nothing, per the paragraph above. Corrected 2026-08-17.)_

**Restore by recreating the index you dropped.** You know exactly what removed it — you did, a
minute ago — so there is nothing to investigate and no data to touch. The gate checks the index's
**shape**, not its name, so these must match field-for-field and in this order:

```bash
mongosh "mongodb://localhost:37018/hms_<slug>" --quiet --eval '
  db.medicationAdministrations.createIndex(
    { tenantId: 1, prescriptionId: 1, lineIndex: 1, scheduledFor: 1 },
    { unique: true, partialFilterExpression: { scheduledFor: { $exists: true } },
      background: true, name: "one_administration_per_dose_slot" });

  db.dispenses.createIndex(
    { tenantId: 1, requestId: 1 },
    { unique: true, partialFilterExpression: { requestId: { $exists: true } },
      background: true, name: "one_dispense_per_request_id" });

  db.orders.createIndex(
    { tenantId: 1, requestId: 1 },
    { unique: true, partialFilterExpression: { requestId: { $exists: true } },
      background: true, name: "one_order_per_request_id" });

  db.encounters.createIndex(
    { tenantId: 1, branchId: 1, "bed.ward": 1, "bed.bedCode": 1 },
    { unique: true,
      partialFilterExpression: { open: { $eq: true }, "bed.bedCode": { $exists: true } },
      background: true, name: "one_open_stay_per_bed_per_branch" });

  db.encounters.createIndex(
    { tenantId: 1, patientId: 1 },
    { unique: true, partialFilterExpression: { open: { $eq: true } },
      background: true, name: "one_open_encounter_per_patient" });'
```

Re-creating an index that is already present is a no-op, so running the whole block is safe and is
the simplest way to be sure you put back whatever you dropped.

**Then confirm with the deployment gate (ENV-03) before moving on** — this is the step that decides
whether the restore worked, and it is not optional:

```bash
pnpm --silent seed:migrate --check --json | jq '.verdict'    # must print "READY"
```

`NOT_READY` with code `schema_drift` means the index is still absent. **A validation session that
leaves a ward drifted is worse than one that never ran**, and every clinical result taken against
that tenant afterwards is void.

| ID           | Attempt                                                                            | Expected                                                                                                               | Notes                                                                                              |
| ------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **DRIFT-01** | Drop the MAR dose-slot index, then **chart a dose**                                | `503 HMS-MAR-002`, header `Retry-After: 60`, message names **paper**                                                   | The nurse must be able to tell this from "no signal". Photograph the screen.                       |
| **DRIFT-02** | Same drop — **record observations** and **write a nursing note**                   | Both still succeed                                                                                                     | Proportionality. If either is blocked it is a **P0** over-block, not a nice-to-have.               |
| **DRIFT-03** | Drop the dispense index, then **hand over drugs**                                  | `503 HMS-PHM-004`; MAR charting still works                                                                            | Two capabilities, one tenant, independent.                                                         |
| **DRIFT-04** | Drop the order index, then **place a test**                                        | `503 HMS-ORD-001`; the lab can still **accept / start / complete / verify / release** work already on the bench        | The state machine is deliberately unguarded — samples must not be stranded mid-analysis.           |
| **DRIFT-05** | Drop the bed-occupancy index, then **admit** and then **transfer a bed**           | Both `503 HMS-ADM-003`; **discharge still works**; bed board still loads                                               | Discharge is deliberately unguarded — a ward that can neither admit nor discharge simply fills up. |
| **DRIFT-06** | Drop the open-encounter index, then **register an arrival**                        | `503 HMS-ENC-001`; patients already in the queue can still be **called in and closed**                                 | Also check the appointment desk's **check-in**, which reaches the same guard.                      |
| **DRIFT-07** | **Recovery** — restore any dropped index, wait up to 60 s, retry the same action   | Succeeds. No restart, no cache flush, no redeploy                                                                      | The 60 s is the readiness TTL. If it needs a restart, that is a **P1** finding.                    |
| **DRIFT-08** | **Second hospital** — with one tenant drifted, do the same clinical act in another | Works normally throughout                                                                                              | Tenant isolation (ADR-0005). A cross-tenant block would be **P0**.                                 |
| **DRIFT-09** | **Nothing was written** — after any DRIFT refusal, re-read the chart / worklist    | No dose, no dispense, no order, no admission, no encounter. The OP encounter in DRIFT-05 is still open, not `admitted` | This is the property the whole design rests on: a refusal leaves nothing to reconcile.             |
| **DRIFT-10** | **Mobile** — repeat DRIFT-01 on the handset                                        | The dose is **not** shown as given. See below.                                                                         | The one row most likely to find a real defect.                                                     |
| **DRIFT-11** | **Server log** — while any DRIFT test runs, watch the API log                      | One `error` line per refusal carrying `code`, `status`, `tenant`, `traceId` and the missing rule + migration           | An operator must be able to act without asking a clinician to read a screen.                       |
| **DRIFT-12** | **PHI check** on the same log lines                                                | No patient name, UHID, encounter id, prescription id or drug in the refusal line                                       | Asserted by `errorContract.test.ts`; confirm it in a real log once.                                |

### 16A.1 · Making each row deterministic — who, where, and what to count

The table above says what to attempt. This one removes the guesswork, because **three of these rows
need a different person than the obvious one** and a tester who reaches a `403` will not be able to
tell it from the refusal being tested.

**Tenant is `sunrise` and branch is A (Main Branch) for every row except DRIFT-08.**

| ID           | Who — and why that person                                                          | Prerequisite (must be true before you drop anything)                                            | Expected HTTP                                                           | Count this in Mongo afterwards — expected value                                                                               |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **DRIFT-01** | **Nurse A** — `mar:administer`                                                     | A **due, unanswered scheduled** dose. Note `prescriptionId`, `lineIndex`, `scheduledFor`.       | `503 HMS-MAR-002` + `Retry-After`                                       | `medicationAdministrations.countDocuments({prescriptionId, lineIndex, scheduledFor})` → **0**                                 |
| **DRIFT-02** | **Nurse A** — `vitals:record`, `nursing:manage`                                    | Any admitted patient in branch A.                                                               | `201` **both**                                                          | one `vitals` row, one `wardNotes` row → **each 1**                                                                            |
| **DRIFT-03** | **Pharmacist** ⚠️ — only role with `pharmacy:dispense`                             | A **signed** prescription with quantity still outstanding.                                      | `503 HMS-PHM-004`                                                       | `dispenses.countDocuments({prescriptionId})` **unchanged**; `lines[].dispensedQty` unchanged                                  |
| **DRIFT-04** | **Doctor** places · **Lab tech** then **Pathologist** move existing work ⚠️        | An open encounter to order against, **and** an order already on the bench to push through.      | Place → `503 HMS-ORD-001`; accept/start/complete/verify/release → `200` | `orders.countDocuments({encounterId})` **unchanged** by the refused placement                                                 |
| **DRIFT-05** | **Doctor** admits (`admission:create`) · **Nurse A** transfers (`bed:allocate`) ⚠️ | An **open OP encounter**, and a **free bed** (ENV-05 leaves 3 of `GW-1…GW-45`).                 | Both `503 HMS-ADM-003`                                                  | `encounters.countDocuments({class:"IP", open:true})` **unchanged**; the OP encounter still `open:true` and **not** `admitted` |
| **DRIFT-06** | **Receptionist** — `encounter:create`                                              | A patient with **no open encounter** (register a fresh walk-in — the 42 admitted all have one). | `503 HMS-ENC-001`                                                       | `encounters.countDocuments({patientId, open:true})` → **0**                                                                   |
| **DRIFT-07** | Whoever ran the refused act                                                        | The index recreated per the block above.                                                        | The original `2xx`                                                      | The row now exists — **1**                                                                                                    |
| **DRIFT-08** | Same act, tenant **`district`**                                                    | `district` converged (ENV-03 covers the fleet).                                                 | Normal `2xx` throughout                                                 | Written normally in `hms_district`; `hms_sunrise` still refusing                                                              |
| **DRIFT-09** | —                                                                                  | Any DRIFT refusal has just occurred.                                                            | Re-read is `200`                                                        | **Every count above is the "nothing happened" value.** This row is the whole point.                                           |

⚠️ **The three rows that will otherwise be misread.** DRIFT-03 is refused with `403` for a nurse or
a doctor, because only PHARMACIST holds `pharmacy:dispense`. DRIFT-04 deliberately splits across a
technician and a pathologist — the state machine treats collapsing them as a patient-safety failure,
not a convenience. And in DRIFT-05 **admitting and moving a bed are two different permissions held
by two different roles** (`admission:create` → DOCTOR, `bed:allocate` → NURSE), so one login cannot
do both halves. In each case a `403 HMS-AUTH-005` means _wrong account_, not a defect — and it is
not the refusal this section is testing.

**Recovery is identical for every row** and is the one thing not to improvise: recreate the index
(block above) → wait up to **60 s** for the readiness cache → retry the same act → then
`pnpm --silent seed:migrate --check --json | jq '.verdict'` must print `READY`. If the retry needs
an API restart, that is **DRIFT-07 failing**, and it is a **P1**.

### What "correct" looks like on mobile (DRIFT-10)

The phone classifies a 503 as **`unknown`** — it re-reads the slot, sees it is still due, and
reports that it could not confirm. That is **safe**: it never shows the dose as given. Record what
the nurse actually sees, and judge it against one question:

> _Would a nurse holding this phone know the dose was NOT recorded, and know to chart on paper?_

If the answer is "she would know it failed but not what to do", record it as a **P2 UX finding**
against the classifier, not as a safety failure — the write provably did not happen. Do **not**
work around it in the field.

---

## 17. DEVICE MATRIX

| Surface                      | Needed for                           | Genuinely requires hardware?                                                                                                               |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Android phone**            | All of M3; M2-35…M2-47 (fingerprint) | **Yes** — a simulator has no enrolled fingerprint, no real radio, no app-switcher snapshot                                                 |
| **Second Android or iPhone** | **MAR-02 concurrency**, M3-35        | **Yes** — two identities must be two sessions. One account signed in twice is one identity, which is exactly what that test must not have. |
| **iPhone with Face ID**      | M2-35…M2-47 on iOS                   | **Yes** — the lock's failure modes differ per platform in ways the port deliberately hides from the code                                   |
| **Small phone (SE / 5")**    | M2-24                                | **Yes**                                                                                                                                    |
| **Desktop browser**          | All of §13                           | No                                                                                                                                         |
| **Tablet / narrow browser**  | WEB-22                               | No — DevTools device emulation is adequate for layout                                                                                      |

**Simulators are acceptable** for layout, navigation and network-off scenarios. They are **not**
acceptable for: biometrics, cellular handover, app-switcher snapshots, or anything in §8.

**Record for every device:** model, OS version, app build/commit, and whether Expo Go or a
development build (ENV-07).

---

## 18. LICENCE / EDITION — LIC-01…LIC-05 are now PREPARED

**Was blocked; the fixture now exists.** LIC-01…LIC-05 need a hospital that is expiring, in grace,
or expired, and none of those states can be reached by USING the product — they are a function of
wall-clock time against `expiresAt` and `graceUntil`, so somebody has to set the dates.

> **The previous instruction here could not have worked.** It said to use `setLicense` with
> `extendDays: -1`. `hospitalLicenseSchema` declares `extendDays` as `min(1)`, so that call is a 400. It had never been run. Corrected below, and the correction is a command rather than console
> arithmetic because expiring the WRONG hospital ends the campaign it was meant to serve.

**LIC-06 remains BLOCKED** — it needs a tenant whose edition excludes `module.clinical.nursing`,
which is a plan/edition question rather than a licence one. Use `pnpm seed:hospital` with a plan
that omits the nursing module, then `pnpm seed:migrate --slug <slug>`.

| ID         | State                                     | Expected                                                                                                                                                          | Status      |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **LIC-01** | Healthy                                   | No banner anywhere                                                                                                                                                | ✅ PREPARED |
| **LIC-02** | **EXPIRING** (inside `LICENSE_WARN_DAYS`) | Amber strip above the tab bar with a day count. **Check the layout** — the banner is new and has never been seen on a device.                                     | ✅ PREPARED |
| **LIC-03** | **GRACE**                                 | Red strip — **and every clinical write still works.** Deliberate: a hospital the server is still serving must still be able to record what was done to a patient. | ✅ PREPARED |
| **LIC-04** | **EXPIRED** (past grace)                  | "Subscription expired" as a blocking state; save controls disabled **with that reason**, rather than failing after the tap                                        | ✅ PREPARED |
| **LIC-05** | **Renewal mid-session**                   | Operator renews while the app is open; pull to refresh clears the block **without a restart**                                                                     | ✅ PREPARED |
| **LIC-06** | **Edition without the nursing module**    | The round says **"Not in this edition"**, never an empty ward                                                                                                     | 🔴 BLOCKED  |

> **"PREPARED" means the state can be produced on demand and was, on 2026-08-17 — not that anybody
> has looked at the screen.** Every row is still unexecuted. This column said `BLOCKED` for LIC-02…05
> until 2026-08-17, contradicting §18.1, §5.1 and §22 in the same document; corrected here.

### 18.1 Preparing the states — one command each

Provision the dedicated hospital ONCE. Never point this at the validation tenant: every other
section depends on it still working, and the script refuses any slug that does not contain
`licence` for exactly that reason.

```bash
pnpm seed:hospital -- --name "Licence Lab" --slug licence-lab --plan PLAN_ENTERPRISE
pnpm seed:migrate  -- --slug licence-lab
```

Then move it between states as the rows require. Each command prints the state the SERVER computed
(`effectiveLicenseState`, the same function the request gate uses), so the line it prints is the
state you are actually testing — not what the script intended:

| Row        | Command                                                    | Prints                          |
| ---------- | ---------------------------------------------------------- | ------------------------------- |
| **LIC-01** | `pnpm seed:licence -- --slug licence-lab --state active`   | `ACTIVE`, ~3650 days remaining  |
| **LIC-02** | `pnpm seed:licence -- --slug licence-lab --state expiring` | `ACTIVE`, 5 days remaining      |
| **LIC-03** | `pnpm seed:licence -- --slug licence-lab --state grace`    | `GRACE`, 6 days remaining       |
| **LIC-04** | `pnpm seed:licence -- --slug licence-lab --state expired`  | `EXPIRED`, 0 days               |
| **LIC-05** | `--state expired`, then `--state active` mid-session       | `EXPIRED` → `ACTIVE`            |
| any        | `pnpm seed:licence -- --slug <slug> --show`                | read-only; safe on any hospital |

Verified end-to-end on 2026-08-17: all four states produced the runtime state named above.

**LIC-02 sits at half the warning window (5 of `LICENSE_WARN_DAYS`=10), deliberately.** A licence
expiring in exactly `LICENSE_WARN_DAYS` days is the boundary case; a banner that failed to appear
there would be reported as a broken banner when it is an ambiguous fixture.

**LIC-03's point is the one that is easy to miss:** in GRACE every clinical write must STILL work.
A red strip AND a working MAR is the pass. If writes are blocked in grace, that is a defect —
`blocksWrites` deliberately excludes GRACE, because a hospital the server is still serving must
still be able to record what was done to a patient.

**LIC-05 needs no restart.** Run `--state active` while the app is open, then pull to refresh.

---

## 19. CONCERNS AND ESCALATION

### 19.1 ⚠️ Two different `D` numbering schemes — read this before citing one

| Scheme              | Form         | Means                                                                                 |
| ------------------- | ------------ | ------------------------------------------------------------------------------------- |
| **Risk register**   | `D1`…`D7`    | **Open, unfixed defects** in [`RISK_REGISTER.md`](RISK_REGISTER.md) §0                |
| **Web fix history** | `D-1`, `D-2` | **Fixed** web defects from the 2026-08-14 closure audit, never confirmed in a browser |

**`D1` and `D-1` are unrelated and point in opposite directions** — one is an open cross-branch PHI
exposure, the other is a fixed identity bug. Always write "risk-register D1" or "web defect D-1".
_Recommendation (not performed here): rename the web pair to `WFIX-1`/`WFIX-2` in a future
documentation pass. That is a change to the tracker's vocabulary and should be a deliberate decision,
not a side effect of this runbook._

### 19.2 Known items — record, cite, do not fix, do not re-report

> **Updated 2026-08-17 after the security audit.** D9, D10 and D11 are new. D9 is the first **P1**
> on this list and the first cross-branch WRITE — read BR-11's "Trap" row before running it, because
> the failure mode returns a 422 that looks like the boundary working. D10 cannot be found by
> clicking: its list was already scoped, so the UI never offered the link.
>
> **Updated 2026-08-16 after a defect-resolution pass.** Four of these are now FIXED, and their
> rows below became **regression checks**: they used to say "expect this to be wrong", and they now
> say "this must be right". Read the Action column before running BR-05, BR-09, TZ-08 or TZ-09 —
> the expected result has inverted. Two entries were reclassified as deliberate design rather than
> defects, which changes what a tester should do when they meet them.

| Ref                 | Item                                                                                        | Sev | Where it shows up      | Action                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------- | --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~D1~~              | Cross-branch **vitals** PHI read                                                            | P2  | **BR-05**              | ✅ **FIXED 2026-08-16** (`bdc027f`). BR-05 is now a REGRESSION check — the foreign visit must 404 and the patient trend must still cross sites. **BR-07 is no longer blocked**: the branch-confined case is proven by test.     |
| ~~D9~~              | Appointment state machine ignored branch scope — cross-branch **WRITE**                     | P1  | **BR-11**              | ✅ **FIXED 2026-08-17** (`4732dd8`). The only confirmed cross-branch WRITE. BR-11 is a regression check, and its second half — re-reading the appointment's state as an A user — is what actually proves it.                    |
| ~~D10~~             | Report **file** download ignored branch scope — cross-branch PHI                            | P2  | **BR-10**              | ✅ **FIXED 2026-08-17** (`c02dd09`). D1's sibling. The list was already scoped, so the UI never offered the link — **this one must be probed directly, not clicked toward.**                                                    |
| **D11**             | An un-stamped legacy report is absent from the branch-scoped list                           | P3  | **BR-10** (also check) | 🟡 **OPEN, pre-existing.** Loses no data and the download agrees with the list. The fix is the same product decision D1 raised: does an un-stamped historical row belong to every branch or to none? Answer once, for all.      |
| ~~D2 / GAP-1~~      | Reception register `?date=` in `env.DEFAULT_TIMEZONE`                                       | P2  | **TZ-08**              | ✅ **FIXED 2026-08-16** (`8330faa`). TZ-08 is now a regression check: the register's day is the BRANCH's day.                                                                                                                   |
| ~~D3 / GAP-2~~      | Bed-day billing counts days in `env.DEFAULT_TIMEZONE`                                       | P2  | **TZ-09**              | ✅ **FIXED 2026-08-16** (`1719360`). TZ-09 is now a regression check. **Money — still worth eyes on.**                                                                                                                          |
| **D4**              | Unknown `X-Active-Branch` silently ignored                                                  | —   | **BR-09**              | 🔵 **NOT A DEFECT.** ADR-0015 chose fail-safe-to-own-scope and tests pin it; BR-09 confirms the DESIGN. The UX wart — one site's name over aggregate data — is a product decision.                                              |
| **D5**              | `limits.maxBranches` not reconciled with the plan                                           | —   | ENV-02                 | 🔵 **BY DESIGN.** The edition figure is a catalogue number deliberately never applied to a tenant. What is open is narrower and is a **PRODUCT DECISION**: should provisioning seed the cap from the plan?                      |
| ~~D6~~              | Migration 0048 over pre-existing duplicate claims                                           | P3  | **ENV-03**             | ✅ **FIXED 2026-08-16** (`ace9512`). It now refuses with the collision count and two copy-pasteable remedies instead of `Index build failed: <uuid>`.                                                                           |
| **D7**              | `administeredBy` renders an identifier, not a name                                          | P3  | MAR-01/02 evidence, §9 | 🟡 **OPEN, deliberately.** The record is complete and audited; only the DISPLAY is degraded. Correct fix is server-side DTO expansion. **Product decision.**                                                                    |
| **T2**              | Fleet-wide migration convergence has no metric                                              | 12  | **ENV-03/04**          | 🟡 **PARTIAL** (`fe6f6e7`) — `pnpm seed:migrate --check` now answers convergence for the whole fleet, read-only and exit-coded. **T2 stays open**: a command is not a scraped gauge, and the observability layer owns the rest. |
| **`not_available`** | A real `MAR_STATUS` the backend accepts and both clients **display** but neither **offers** | —   | **M3-33**              | **PRODUCT DECISION REQUIRED** — should a nurse be able to select it?                                                                                                                                                            |

### 19.3 Classifying something new

Ask, in order:

1. **Is the environment sound?** Re-run `pnpm seed:validation -- --verify`. If it does not say READY,
   the finding is **ENVIRONMENT ISSUE** until proven otherwise. _On 2026-08-14 this single question
   was the difference between seven P0 reports and zero._
2. **Is it in §19.2?** → **KNOWN DEFECT**. Cite the ID and move on.
3. **Did clinical data change, duplicate, or get lost?** → **P0/P1.** Stop the workflow, capture §20's
   extended evidence, report before continuing.
4. **Is it cross-branch or cross-tenant data?** → **P1 candidate.** Capture what was visible, to whom,
   and whether writes were possible.
5. **Does the repository define what should happen?** If not → **PRODUCT DECISION REQUIRED.** Describe
   what you saw and what you expected and why. **Do not invent the expected result.**
6. Otherwise → **FAIL**, with severity by clinical impact.

### 19.4 Raise, never work around

Never "work around" and continue: a missing safety constraint · a duplicated or lost clinical record ·
cross-branch or cross-tenant data · a false success message · a five-rights field that is blank ·
anything that made you say "that can't be right" and then carry on.

---

## 20. EVIDENCE STANDARD

### 20.1 Every test

```
TEST ID        e.g. MAR-02
DATE/TIME      with timezone — the branch's and the device's if they differ
DEVICE         model · OS version · Expo Go or dev build · commit
SURFACE        mobile / web / API
TENANT         sunrise
BRANCH         Main Branch (Asia/Kolkata) | second site (America/New_York)
ROLE           Nurse A / Nurse B / Doctor / Receptionist / Tenant admin
PRECONDITION   what was true before, including the --verify result
STEPS          what you actually did, not what the runbook said
EXPECTED       from this document
ACTUAL         what happened
RESULT         PASS / FAIL / BLOCKED / ENVIRONMENT ISSUE / DATA ISSUE / KNOWN DEFECT / PRODUCT DECISION REQUIRED
EVIDENCE       screenshot / video / network capture / query output
NOTES          anything that surprised you
```

### 20.2 Additionally, for any safety failure

```
SERVER RESPONSE     status code, error code, full body
DATABASE STATE      the MAR-03 query output
DUPLICATE COUNT     exact number of rows for that dose slot
USER IDENTITY       which nurse, both sessions if concurrent
TIMESTAMPS          request sent · server committed · client observed
REPRODUCTION        minimal steps; whether it reproduced on a second attempt
SEVERITY            P0 / P1 / P2 / P3 with the reasoning
CLINICAL STATE      did clinical data change, duplicate, or get lost?
NETWORK CONDITION   for any lost-response test
BOTH SESSIONS       for any concurrency test — screenshots of both screens
```

### 20.3 Two habits worth keeping

- **Capture the `--verify` output at the start and end of every session.** It is the cheapest possible
  proof that the environment you tested is the environment you think you tested.
- **Do not put test counts in this document.** Counts go stale silently and then get quoted. Run the
  command and quote the run:

  ```bash
  pnpm gate                              # the whole gate
  pnpm --filter @medicore/api test       # API unit
  pnpm --filter @medicore/mobile test    # mobile
  pnpm --filter @medicore/web test       # web
  ```

  The two device checklists' row counts **are** verified as of `39e2dff`: M2 **61**, M3 **45**.

---

## 21. DOCUMENTATION STATE FOUND DURING PREPARATION

Recorded because a runbook built on stale documents inherits their staleness.

| Finding                                   | Detail                                                                                                                                                                                                                                                                                              | Action                                                                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The web checklist does not exist**      | `projectTracker.md` §9 Stage A marks _"Web checklist written — 30 scenarios, in the Phase 1 plan"_ as **done** `[x]`. **No such document is in the repository**, no file defines `WEB-nn` test IDs, and the scratchpad directories are empty. It was written in a conversation and never persisted. | **§13 of this runbook now supplies it**, written from the implementation rather than recovered. The tracker's claim is corrected in the same commit. |
| **`--verify` output shape changed**       | The M3 checklist says it must print _"READY, 19/19"_. It now prints a **SCHEMA** block of 3 checks **then** 19 data checks.                                                                                                                                                                         | §3 of this runbook states the current output. The checklist's STEP ZERO is otherwise accurate.                                                       |
| **Expo Go claim is asserted, not proven** | Both checklists state "Expo Go is sufficient". Inspection at `39e2dff` is **consistent** with that (managed workflow, no `expo-dev-client`, all-Expo native deps, SDK 54). **No device has confirmed it.**                                                                                          | **ENV-07** turns the assertion into a test, with an instruction to correct both checklists if it fails.                                              |
| **Row counts verified**                   | Tracker claims M2 → 61/61 and M3 → 45/45. Counted at `39e2dff`: **61 and 45.**                                                                                                                                                                                                                      | Accurate. No change.                                                                                                                                 |
| **Defect ID collision**                   | `D1`…`D7` (risk register, open) vs `D-1`/`D-2` (web, fixed).                                                                                                                                                                                                                                        | Flagged in §19.1; rename **recommended, not performed**.                                                                                             |

**Found in the second preparation pass, 2026-08-17.** All four are the same failure: an instruction
or a claim that nobody had executed since the thing it described changed.

| Finding                                        | Detail                                                                                                                                                                                                                                                                                                                          | Action                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 🔴 **§16A's restore command could not work**   | It said `pnpm seed:migrate -- --tenant <slug>`. `--tenant` is not parsed (the CLI takes `--slug`, `--all`, `--check`, `--json`), so it exits 1. And `--slug` restores **nothing**: the runner skips migrations already recorded, and dropping an index leaves its record — it reports "converged" over a still-unsafe database. | **Fixed.** §16A now recreates the index directly and proves it with `--check`. This is the most consequential of the four. |
| 🔴 **§4 could not run tests §16A already had** | Six accounts listed; DRIFT-03 needs a PHARMACIST and DRIFT-04 needs a LAB_TECHNICIAN _and_ a PATHOLOGIST. None was listed, though all are seeded by `seed:demo`.                                                                                                                                                                | **Fixed.** All eleven seeded accounts are now in §4.                                                                       |
| **Ten clinical flows had no row**              | §13 covers 2 of 44 web pages. Registration, reception, appointments, consultation, ordering, dispensing, admission, bed transfer, discharge and billing appeared only where they crossed a safety control.                                                                                                                      | **§13A added.** §22 now also names the twelve pages with no manual coverage at all.                                        |
| **`STATE_MACHINE_CATALOG` §3 was stale**       | Still said bed inventory was "NOT built" and "nothing stops two patients being recorded in bed A-12". False since 2026-07-28; double-occupancy is refused by a unique index and runtime-guarded by `HMS-ADM-003`. A tester would have read the correct `409` as a defect.                                                       | **Fixed in that file**, and in `PROJECT_MEMORY` §5 which it cited.                                                         |

---

## 22. WHAT THIS RUNBOOK STILL CANNOT TELL YOU

Stated so nobody mistakes preparation for coverage.

1. **No result in this document is a result.** Every row is unexecuted.
2. **The environment gate covers one tenant at one moment.** Risk register **T2** — a fleet-wide
   convergence metric — remains open and is not addressed here.
3. **BR-07 is blocked**, so the branch-_confined_ user — the account with the least coverage in the
   whole product — remains **empirically unproven through a UI**. D1's confined case is now proven
   by test, but the 2026-08-17 audit then found three MORE branch-scope defects (D9, D10, D11) on
   paths no test walked with two branches configured. Automated coverage of this dimension has been
   wrong three times in one day; unblocking BR-07 is the single highest-value account here.
   **In particular, D10 could never have been found by clicking** — its list was already scoped, so
   the UI correctly hid a document the API would still serve. A tester following screens would have
   reported everything as working.
4. **§18 is prepared for LIC-01…LIC-05** (`pnpm seed:licence`, verified 2026-08-17). **LIC-06 remains blocked** — it needs an edition that excludes the nursing module, which is a plan question, not a licence one.
5. **Expected results are drawn from the implementation and its comments.** Where the implementation
   is self-consistent but the _intent_ is unstated, the row says `PRODUCT DECISION REQUIRED` rather
   than guessing. Those are decisions for people, not for a tester and not for an agent.
6. **§13A is one pass over each flow, not coverage of any of them.** The journey walks registration,
   reception, appointments, consultation, ordering, dispensing, admission, bed transfer, discharge
   and billing exactly **once**, on the happy path plus the four refusals that have a safety
   argument behind them. It is enough to prove the flows connect and that the guards fire; it is
   **not** a functional test of billing, of scheduling, or of the lab. Those modules have automated
   suites and no manual checklist of their own, and this section should not be read as supplying
   one.
7. **These pages have no manual coverage at all**, and are not in this document: `/mrd`,
   `/mortuary`, `/theatres`, `/ambulance`, `/assets`, `/insurance`, `/packages`, `/tariff`,
   `/feedback`, `/audit`, `/subscription`, `/reports`. Some are deliberate (audit and subscription
   are operator surfaces); the rest are simply untested by hand. **Say so in the campaign report
   rather than letting a green run imply the product was covered.**
