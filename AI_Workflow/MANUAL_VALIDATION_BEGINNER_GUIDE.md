# MediCore HMS — Beginner Manual Validation Guide

> # ⚠️ SUPERSEDED — 2026-08-18
>
> **You are not expected to execute this campaign.** The day after this guide was written, the
> validation strategy changed: the manual rows were converted into automated engineering
> validation instead. See [`TESTING.md`](../TESTING.md) §11 for the audit and what now proves what.
>
> **The guide is kept, and is still worth reading**, for two reasons. Its explanations of tenant,
> branch, hospital-wide versus branch-confined, and why a `404` is often the correct answer are the
> shortest introduction to this system's security model that exists. And if a human ever does need
> to reproduce a scenario by hand — to confirm an automated finding, or to look at something no
> test can see — the procedures here are accurate and were checked against the implementation.
>
> **What has changed is only the expectation.** Nothing in the tracker at §30 needs to be filled in.

> **This document is a companion, not a replacement.**
> [`docs/MANUAL_VALIDATION_RUNBOOK.md`](docs/MANUAL_VALIDATION_RUNBOOK.md) owns the test IDs and the
> expected results. Everything here explains **how to actually perform them** if you have never done
> this before. Where the two ever disagree, **the runbook is right and this guide has a bug** —
> report it rather than following it.
>
> Every ID, expected status, error code, account, branch, tenant and prerequisite in this guide was
> cross-checked against the runbook and against the code on **2026-08-17**. Where the runbook is
> ambiguous or where a step could not work as written, this guide **preserves the original
> requirement** and adds a clearly-marked clarification. Those are all listed in §33.

---

## 🛑 READ THIS BEFORE YOU TOUCH ANYTHING

- **TEST ENVIRONMENT ONLY.** Everything below runs against your own machine's Docker containers.
- **NEVER use a production tenant.** Not once, not "just to check".
- **NEVER use real patient data.** Every name, phone number and UHID you create must be invented.
- **NEVER run destructive database commands outside the exact documented procedure** in §11–§18.
  Those sections drop database indexes on purpose and put them back in the same session.
- **NEVER modify application code while executing a test.** If you change code mid-campaign, every
  result before the change is void.
- **NEVER mark a test PASS without actually performing it.** The automated suite being green is not
  evidence for any row in this document. See §25.
- **NEVER read an expected `403` / `404` / `503` as a defect** before checking you used the right
  account, the right branch and the right prerequisite. Most first-day "defects" are one of those.
- **NEVER read an unexpected success as "probably fine".** A write that should have been refused and
  was not is the most serious thing you can find here. Stop and report.

---

## 1. What This Guide Is

### Why we are doing this at all

The automated test suite runs in Node. It has no screen, no camera, no fingerprint reader, no radio,
and no second human being. So there is a whole category of failure it physically cannot see:

| The suite cannot see                | Because                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| A blank patient name **on screen**  | It checks the field is in the data, not that it renders      |
| A UHID unreadable at arm's length   | No test has eyes                                             |
| The fingerprint / Face ID prompt    | No enrolled biometric exists in CI                           |
| **Two nurses racing the same dose** | Two test clients are one process. Two people are two people. |
| A response lost to a real radio     | A mocked failure is a decision; a lost packet is an accident |
| A phone whose clock is 9½ hours out | The suite fakes a timezone; a device _lives_ in one          |

You are here to look at exactly those things.

### What automation already proved

|                                        |                             |
| -------------------------------------- | --------------------------- |
| **Full release gate**                  | GREEN end to end            |
| **Integration suite**                  | 1842 / 1842 passing         |
| **T3** (the intermittent gate failure) | Root cause proven and fixed |

That means the server-side rules **can** be enforced. It does **not** mean any screen shows them
correctly, and it is not evidence for a single row you are about to run.

### What manual validation proves that automation cannot

That a real person, on a real screen, in a real hospital, would be **told the truth** — and would be
stopped when the product needs to stop them.

### Status right now

```
AUTOMATED ENGINEERING:  GREEN
MANUAL VALIDATION:      REQUIRED  (0 of 232 rows executed)
PILOT:                  NOT READY
```

---

## 2. Before You Start

Work through this list **in order**, top to bottom. Do not skip. **Step 5 is a hard gate: if it does
not print `READY`, every clinical result you take afterwards is void** (runbook §3).

Open a terminal at the repository root: `/Users/mac/projects/ops/HMS/medicore-hms`.

### 2.1 Confirm you are in a test environment

```bash
git status              # should say "working tree clean"
git branch --show-current
```

If the tree is **not** clean, stop and ask before continuing — someone's unfinished work is in the
build you are about to test, and you will not know which failures are theirs.

### 2.2 Start the databases

```bash
pnpm docker:dev         # databases; leave running
```

**What success looks like:** the command exits without error and

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
```

lists the MediCore containers as `Up` (Mongo, Redis, MinIO, Mailhog).

> ⚠️ **If any container says `Exited (137)`,** that is your machine running out of Docker memory —
> not a bug in the product. Free memory (quit other projects' containers) and start again.
> Nothing below is meaningful until every container is `Up`.

> ⚠️ **Docker Desktop must be running first.** If `pnpm docker:dev` errors with something about a
> socket, open Docker Desktop, wait for it to say _Running_, and re-run. None of the containers
> restart by themselves.

### 2.3 Start the application

```bash
pnpm dev                # API :4000, web :3000, workers; leave running
```

Leave this terminal open for the whole session. Open a **second** terminal for everything else.

### 2.4 Check the API is alive and ready

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4000/health
```

**Expected: `200`.** (Runbook ENV-01.)

Readiness — this one also checks the API can reach its dependencies:

```bash
curl -s http://localhost:4000/ready | jq
```

**Expected:** a JSON body reporting its checks, with an HTTP `200`. A `503` here means a dependency
is down — go back to 2.2.

### 2.5 Seed the accounts, hospitals and the validation ward

```bash
pnpm seed:operator      # the console operator
pnpm seed:demo          # Sunrise + District hospitals, and all staff
pnpm seed:migrate --all       # bring every tenant's schema up to date
pnpm seed:migrate --check     # read-only: is the fleet ACTUALLY up to date?
```

**Expected from `--check`:** each tenant logs `ready`, then

```
READY — every tenant is on this release's schema, and it is armed
```

and the command exits `0`. (Runbook ENV-03.)

> ⚠️ **`tenant converged` is weaker evidence than it sounds.** The migration runner skips any
> migration it has already recorded. If an index was dropped by hand, it will still say "converged"
> while changing nothing. **The next step is what actually checks.**

### 2.6 🔴 THE GATE — build and verify the validation ward

```bash
pnpm seed:validation                 # builds the ward
pnpm seed:validation -- --verify     # read-only; must print READY
```

**Expected — the schema block first, then the data block** (runbook ENV-04):

```
  SCHEMA — the database can enforce what is being validated
  ✓ the same scheduled dose cannot be charted twice
  ✓ one Idempotency-Key claim survives, so a retry replays instead of repeating
  ✓ every migration applied (49)
  DATA
  ✓ … 19 checks …
  READY — schema armed, every data check passed.
```

**If it prints `VALIDATION BLOCKED`: STOP.** Do not start any clinical test. The message names the
missing invariant and the correct remedy. Follow it, re-run, and only then continue.

**Save this output.** Paste it at the top of your results file. Run `--verify` again at the **end**
of the session too — if it still says READY, the environment you tested is the environment you think
you tested.

The seed also prints your fixtures. It looks like this:

```
  Manual-validation environment ready — sunrise
  Nurse         nurse@sunrise.test / 123456
  Second nurse  nurse2@sunrise.test / 123456   — for the concurrent-dose test
  Branch A      Main Branch · Asia/Kolkata
  Branch B      Riverside Annexe · America/New_York
  Ward          General Ward · 45 beds · 42 admitted
  Round         http://sunrise.localhost:3000/medication-round
```

**Copy the Branch B name from your own output**, not from this guide — if your hospital had already
hit its branch cap the seed _adopts_ an existing site instead, and says so on that line.

### 2.7 Check the web app opens

Open a browser at **`http://sunrise.localhost:3000`**. You should get the MediCore login page.

> If you later change `TENANT_BASE_DOMAIN` for phone testing (§21), this URL changes too. See §21.

### 2.8 What you need physically

| For                        | You need                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Everything in Part A, B, D | A desktop browser. That is all.                                                                                                         |
| Part C (the journey)       | A desktop browser.                                                                                                                      |
| Part E (mobile)            | A real Android phone and/or iPhone.                                                                                                     |
| **MAR-02, WEB-16, M3-35**  | **Two devices and two different logins.** One account signed in twice is one identity, which is exactly what those tests must not have. |
| M2-24                      | A small phone (iPhone SE / 5" Android).                                                                                                 |
| M2-35…M2-47                | A device with a fingerprint or Face ID **enrolled**.                                                                                    |

**If you only have one device, that is fine.** Run everything else and mark the two-device rows
**BLOCKED**. Never fake a second nurse by signing the same account in twice.

### 2.9 Session checklist

```
[ ] git tree clean
[ ] Docker containers all Up (no Exited 137)
[ ] pnpm dev running
[ ] /health returned 200
[ ] pnpm seed:migrate --check said READY
[ ] pnpm seed:validation -- --verify said READY   ← saved the output
[ ] Browser opens http://sunrise.localhost:3000
[ ] A results file open, with today's date
[ ] A folder ready for screenshots
```

---

## 3. Important Concepts for Beginners

You need five ideas. None of them requires knowing how the code works.

### 3.1 Tenant = one hospital company

A **tenant** is a whole customer — one hospital organisation. In MediCore each tenant has **its own
separate database**. Not a shared table with a filter: a genuinely different database
(architecture decision ADR-0005).

You will use two:

| Tenant slug | Hospital                  | Where you reach it               |
| ----------- | ------------------------- | -------------------------------- |
| `sunrise`   | Sunrise Multispeciality   | `http://sunrise.localhost:3000`  |
| `district`  | District General Hospital | `http://district.localhost:3000` |

**The web address IS the tenant.** `sunrise.localhost:3000` and `district.localhost:3000` are two
different hospitals. There is no "choose your hospital" dropdown after login on web — the hostname
already decided.

### 3.2 Branch = one site of that hospital

A **branch** is a physical site belonging to one tenant — a main building and an annexe, say. Both
branches are inside the _same_ database, and rows are stamped with which branch they belong to.

|                   | Branch A         | Branch B                                             |
| ----------------- | ---------------- | ---------------------------------------------------- |
| Name              | **Main Branch**  | **Riverside Annexe** (confirm from your seed output) |
| Timezone          | `Asia/Kolkata`   | `America/New_York`                                   |
| Ward              | **General Ward** | **Annexe Ward**                                      |
| Beds              | `GW-1` … `GW-45` | `AW-…`                                               |
| Admitted patients | 42               | 3                                                    |

The two timezones are 9½–10½ hours apart **on purpose**, so the two wards are on different calendar
days during normal working hours. That is what makes the timezone tests possible.

### 3.3 Branch-scoped vs hospital-wide

Some things belong to a site. Some deliberately belong to the whole hospital. **Knowing which is
which is the difference between reporting a real defect and reporting a design decision.**
(Runbook §11.1 is the authority — this is a copy.)

| Data                                    | Scope                         | Why                                              |
| --------------------------------------- | ----------------------------- | ------------------------------------------------ |
| Encounters, admissions, ward lists      | **Branch**                    | A stay happens at a site                         |
| Medication schedule and administrations | **Branch**                    | A dose is given at a site                        |
| Nursing notes                           | **Branch**                    | Same                                             |
| Vitals                                  | **Branch**                    | Was a defect (D1); fixed 2026-08-16              |
| Report files (the PDF itself)           | **Branch**                    | Was a defect (D10); fixed 2026-08-17             |
| Appointment transitions                 | **Branch**                    | Was a defect (D9); fixed 2026-08-17              |
| **Patient identity lookup**             | **Hospital-wide, deliberate** | A person's name is not site-specific             |
| **Allergies**                           | **Hospital-wide, deliberate** | _"An allergy does not stop at a site boundary."_ |
| **Wallet balance and receipts**         | **Hospital-wide, deliberate** | One advance purse per patient → **BR-12**        |

**If you find something hospital-wide that this table says is hospital-wide, that is a PASS, not a
leak.** BR-12 exists specifically so nobody "fixes" one of these.

### 3.4 Hospital-wide user vs branch-confined user

This is the distinction most beginners miss.

- A **hospital-wide user** may work at _any_ branch and can **switch** between them. Both seeded
  nurses are hospital-wide. When they act, the app sends a header saying which branch they are
  currently working in.
- A **branch-confined user** is _bound_ to specific branches by their staff record. They cannot
  switch away, and the server will not let them reach another site's data **even if they ask for it
  directly**.

**Why it matters:** a hospital-wide user asking for another branch's data is a person changing desks.
A confined user asking for it is a person reaching somewhere they were never allowed. Those are
different security questions, and only the first one currently has an account to test it with.
Creating the second account is **BR-07** (§8), and the runbook calls it _"the single highest-value
account in the campaign"_.

### 3.5 How to switch branch

**On web:** the branch name is a button in the top bar. Click it and a menu opens listing the
branches you may work in, plus **"All branches"** if you are allowed to aggregate. Pick one. The page
reloads that branch's data — and it _discards_ the previous branch's data rather than merging it.

**On mobile:** the branch is in the app header; tap it and pick.

**At the API:** you send a header, `X-Active-Branch: <branch id>`. §5.4 shows how to get the id.

### 3.6 Why branch isolation matters

> A nurse working at **Riverside Annexe** must not be able to open a **Main Branch** patient's chart,
> download their scan, or change their appointment — **even if somebody hands her the exact ID**.

That last clause is the whole test. Hiding a link is not security; the server has to refuse.

On 2026-08-17 an audit found **three** cross-branch defects in code that had passed review with green
tests. One of them was a **write**. One of them (**D10**) could never have been found by clicking,
because the list was already correctly scoped — the UI never offered the link while the API still
served the file. **That is why Part A is probed directly with `curl` rather than clicked.**

### 3.7 Why tenant isolation is a different question

Branch isolation is about _scoping inside one database_. Tenant isolation is about _two different
databases_. They fail differently and they matter differently:

- A branch leak inside one hospital is serious.
- A **tenant** leak means one hospital can see another hospital's patients. That is a **P0 — stop the
  campaign and report immediately** (runbook TEN-01).

And note the deliberate asymmetry: **patient identity is tenant-wide but branch data is not.** Seeing
a patient's _name_ across branches of the same hospital is correct. Seeing anything at all across
_tenants_ is not.

---

## 4. Test Accounts

All synthetic. **Password for every account below is `123456`.** That password is documented in the
repository (`seedDemo.ts` prints it and refuses to run against production) and is dev-only. **No real
credentials appear in this guide and none may ever be added to it.**

All are created by `pnpm seed:demo` in tenant **`sunrise`**, as `<key>@sunrise.test`. **Every one of
them is hospital-wide** (not confined to a branch) — which is exactly why BR-07 needs a new account.

| Alias            | Login                      | Role           | Tenant     | Branch scope      | What you need it for                                                     |
| ---------------- | -------------------------- | -------------- | ---------- | ----------------- | ------------------------------------------------------------------------ |
| **Nurse A**      | `nurse@sunrise.test`       | NURSE          | sunrise    | Hospital-wide     | M3, five rights, MAR, vitals, notes, BR-10, DRIFT-01/02, JR-15/16/17     |
| **Nurse B**      | `nurse2@sunrise.test`      | NURSE          | sunrise    | Hospital-wide     | **MAR-02 concurrency**, M3-35 staleness — the _second identity_          |
| **Doctor**       | `drrao@sunrise.test`       | DOCTOR         | sunrise    | Hospital-wide     | All of M2, JR-08/09/11/13/18/19/22, DRIFT-04/05, permission denials      |
| **Doctor 2**     | `drkhan@sunrise.test`      | DOCTOR         | sunrise    | Hospital-wide     | **JR-06 handover** — the one journey row needing two doctors             |
| **Receptionist** | `reception@sunrise.test`   | RECEPTIONIST   | sunrise    | Hospital-wide     | **BR-11**, JR-01…JR-07, DRIFT-06, TZ-08                                  |
| **Pharmacist**   | `pharmacy@sunrise.test`    | PHARMACIST     | sunrise    | Hospital-wide     | **DRIFT-03**, JR-12, DUP-01                                              |
| **Lab tech**     | `labtech@sunrise.test`     | LAB_TECHNICIAN | sunrise    | Hospital-wide     | **DRIFT-04** (accept / start / complete), JR-10                          |
| **Pathologist**  | `pathologist@sunrise.test` | PATHOLOGIST    | sunrise    | Hospital-wide     | **DRIFT-04** (verify / release), JR-10 — _a different person on purpose_ |
| **Radiologist**  | `radiologist@sunrise.test` | RADIOLOGIST    | sunrise    | Hospital-wide     | JR imaging orders                                                        |
| **Cashier**      | `cashier@sunrise.test`     | CASHIER        | sunrise    | Hospital-wide     | **JR-20/21 billing**                                                     |
| **Tenant admin** | `admin@sunrise.test`       | TENANT_ADMIN   | sunrise    | Hospital-wide     | Branch config, BR-06, **creating the BR-07 account**                     |
| **Operator**     | `ops@paperlesstech.in`     | SUPERADMIN     | _platform_ | n/a               | §18 licence states (or use `pnpm seed:licence`)                          |
| **Nurse C**      | _you create it_            | NURSE          | sunrise    | **Branch B ONLY** | **BR-07** — see §8. Does not exist yet.                                  |

### Which account for which test — the three that catch everyone

The runbook flags these because a `403` from using the wrong login looks exactly like the refusal you
are trying to test:

| Test                      | You must use                                                                    | If you use anyone else you get                |
| ------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------- |
| **DRIFT-03** (dispensing) | **Pharmacist** — the only role with `pharmacy:dispense`                         | `403 HMS-AUTH-005`, which is **not** the test |
| **DRIFT-04** (ordering)   | **Doctor** places · **Lab tech** then **Pathologist** move existing work        | Same. Two logins are required by design.      |
| **DRIFT-05** (beds)       | **Doctor** admits (`admission:create`) · **Nurse A** transfers (`bed:allocate`) | Same. One login cannot do both halves.        |

> **A `403 HMS-AUTH-005` in a DRIFT test means _wrong account_, not a defect.** Check §4 before
> writing anything down.

### What a nurse deliberately cannot do

From `packages/permissions/src/index.ts`, a NURSE holds `patient:read`, `encounter:read`,
`encounter:update`, `record:read`, `consent:manage`, `emr:read`, `vitals:record`, `allergy:read`,
`allergy:manage`, `nursing:manage`, `mar:administer`, `lab:collect`, `order:read`, `order:perform`,
`bed:allocate`, `mortuary:manage`, `mortuary:release`, `appointment:read`, `file:read`.

A nurse **deliberately does NOT hold** `emr:write` (the doctor's clinical note) or `encounter:close`.
Both are tested in PERM-05 and PERM-07, and both must be **refused**.

---

## 5. Test Environment / Fixture Reference

**You do not need to create any of these yourself unless a test explicitly says to create one.**
`pnpm seed:validation` built them all in §2.6.

### 5.1 The ward

| Item                | Value                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Tenant              | `sunrise`                                                                                                                           |
| Branch A            | **Main Branch** · `Asia/Kolkata` · ward **General Ward** · beds `GW-1`…`GW-45` · **42 admitted**                                    |
| Branch B            | **Riverside Annexe** · `America/New_York` · ward **Annexe Ward** · beds `AW-…` · **3 admitted**                                     |
| Long-stay patient   | bed **GW-1** — registered _first_, so it falls outside the 100-most-recent window. This is the exact case web defect **D-1** broke. |
| Medicated patients  | 12, from 6 prescription shapes                                                                                                      |
| Quiet patients      | 30 with nothing due — the "No scheduled doses today" case                                                                           |
| Drugs               | Paracetamol 500mg · Pantoprazole 40mg · Metformin 500mg · Amlodipine 5mg · Cetirizine 10mg — **all route `oral`, 5-day courses**    |
| `lineIndex` cases   | a 3-line prescription, and the **same drug scheduled AND as-required**                                                              |
| Allergies           | at least one **severe**                                                                                                             |
| Deliberately absent | **no vitals, no nursing notes, no administered doses** — those are the writes you are here to make                                  |

**Round times:** OD 08 · BD 08/20 · TDS 08/14/20 · QID 06/12/18/22 · HS 22 · SOS as-required ·
STAT once.

> **Overdue doses are a clock state, not seeded data.** A course starts from the prescription's
> `signedAt`, so a prescription signed at noon has no 08:00 dose to be late for. `--verify` prints
> the wall-clock minute the first overdue dose appears. **Seed before 08:00 ward time** if you want a
> full day of natural due→overdue transitions.
>
> **Do not backdate `signedAt` to manufacture an overdue dose.** It is a medico-legal timestamp.

### 5.2 IDs you will need, and how to get them

The runbook deliberately does **not** print database IDs, because they are regenerated every time you
re-seed. **Look yours up** — §5.4 shows how. You will need:

| What                                           | Where to get it                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Branch A id, Branch B id                       | `GET /api/v1/me/branches` (§5.4)                                                              |
| A patient id / UHID                            | The `/patients` screen, or `GET /api/v1/patients`                                             |
| An encounter id                                | The `/ward` screen, or `GET /api/v1/encounters`                                               |
| A prescription id, `lineIndex`, `scheduledFor` | The medication round confirmation screen, or `GET /api/v1/encounters/:id/medication-schedule` |
| A report id                                    | `GET /api/v1/patients/:id/reports` **as a branch-A user** (BR-10)                             |
| An appointment id                              | The `/appointments` screen (BR-11)                                                            |

**Write these down as you go.** Half the rows in Part A and Part B need an ID you noted in an
earlier step.

### 5.3 Your toolbox — the four things every API step needs

You do not need to know how APIs work. You need four commands. Read this section once and the rest
of the guide will make sense.

**Check you have the tools:**

```bash
curl --version | head -1
jq --version              # if this fails: brew install jq
mongosh --version         # if this fails: brew install mongosh
```

`jq` just makes JSON readable. `mongosh` is how you look directly in the database to check that a
refused action really did leave nothing behind.

### 5.4 Recipe 1 — log in and get a token

A "token" is a temporary pass the server gives you when you sign in. Every other request carries it.

```bash
BASE=http://sunrise.localhost:4000

TOKEN=$(curl -s "$BASE/api/v1/auth/login" -X POST \
  -H 'Content-Type: application/json' \
  -d '{"email":"nurse@sunrise.test","password":"123456"}' | jq -r '.data.accessToken')

echo "${TOKEN:0:20}…"      # should print ~20 random characters, not "null"
```

**If it prints `null…`:** the login failed. Print the whole response to see why:

```bash
curl -s "$BASE/api/v1/auth/login" -X POST -H 'Content-Type: application/json' \
  -d '{"email":"nurse@sunrise.test","password":"123456"}' | jq
```

- `HMS-TEN-001` → the _hostname_ did not match a hospital. Check you used `sunrise.localhost:4000`.
- `HMS-VAL-001` / `HMS-AUTH-…` → the hostname was fine; the credentials were not.

> **The hostname is the hospital.** `http://localhost:4000` with no `sunrise.` in front will fail
> with `HMS-TEN-001` every time. This is the single most common beginner mistake.

**Now get your branch ids:**

```bash
curl -s "$BASE/api/v1/me/branches" -H "Authorization: Bearer $TOKEN" | jq '.data.branches'
```

You will get something like:

```json
[
  { "id": "66b…a1", "name": "Main Branch", "code": "MAIN", "timezone": "Asia/Kolkata" },
  {
    "id": "66b…b7",
    "name": "Riverside Annexe",
    "code": "RIVERSIDE",
    "timezone": "America/New_York"
  }
]
```

Save them:

```bash
BRANCH_A=66b…a1        # Main Branch
BRANCH_B=66b…b7        # Riverside Annexe
```

> **Clarification (see §33-D):** use **`/me/branches`**, not `/branches`. `/branches` requires the
> `branch:manage` permission, which a nurse does not hold — you would get a `403` and think something
> was broken. `/me/branches` is the switcher's own endpoint and needs no permission.

### 5.5 Recipe 2 — make a request as a particular person, at a particular branch

Every API step in this guide is this shape:

```bash
curl -s -i "$BASE/api/v1/<path>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Active-Branch: $BRANCH_B"
```

- `-s` = quiet. `-i` = **show me the response headers as well as the body**. You want `-i`, because
  the status code and headers like `Retry-After` are part of several expected results.
- `Authorization: Bearer $TOKEN` = who you are.
- `X-Active-Branch` = which site you are working at right now.

**To see only the status code** (useful when the expected result is just "403"):

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/v1/<path>" \
  -H "Authorization: Bearer $TOKEN" -H "X-Active-Branch: $BRANCH_B"
```

### 5.6 Recipe 3 — read a response

A refusal always looks like this:

```json
{
  "success": false,
  "error": {
    "code": "HMS-GEN-404",
    "message": "Not found",
    "traceId": "6d2f…"
  }
}
```

**Record the `code`, not just the number.** `403 HMS-AUTH-005` (you lack the permission) and
`404 HMS-GEN-404` (the thing is outside your scope) mean different things, and several tests
distinguish them.

> **Why some refusals are `404` and not `403`:** a `403` would confirm the record _exists_. For a
> resource outside your branch or tenant, the server says `404` on purpose — you are not allowed to
> learn that it is there. **A `404` where you expected `403` in a branch test is usually correct.**

A success looks like `{"success": true, "data": { … }}` with a `200` or `201`.

### 5.7 Recipe 4 — check the database directly

This is how you prove a refused action **wrote nothing**. Mongo runs on port **37018** in this
environment, and the database for tenant `sunrise` is `hms_sunrise`.

```bash
mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
  db.medicationAdministrations.countDocuments({})'
```

That prints a number. The pattern for every "verify nothing was written" step is:

1. Count **before** you try the thing.
2. Try the thing; observe the refusal.
3. Count **after**.
4. **The two numbers must be identical.**

> **You are reading, not writing.** `countDocuments` and `find` change nothing. The only commands in
> this guide that change the database are the `dropIndex` / `createIndex` pair in Part B, and those
> are always paired.

### 5.8 Recipe 5 — how to verify a failed request did not change anything

Three levels, use as many as the test asks for:

1. **Re-read it in the UI.** Refresh the screen. Is the thing still in its original state?
2. **Re-read it at the API, as a user who _is_ allowed** to see it. This is the important one for
   branch tests — you check from the _other_ branch, where you can legitimately look.
3. **Count the rows in Mongo** (Recipe 4). This is the only one that cannot be fooled by a cache.

**BR-11 is the test that exists to teach this.** Getting a refusal is not enough; you have to go and
look at the appointment afterwards.

---

# PART A — SECURITY VALIDATION

**Run this part first, before anything else.** Runbook §5.0: these are regression checks on fixes
that are days old, on the exact dimension where automated coverage was **wrong three times in one
day**.

> 🔴 **If BR-10, BR-11 or BR-07 fails, stop and report before continuing.** A failure means a
> two-day-old fix did not hold on a real client.

---

## 6. BR-10 — Cross-Branch Report File

**This must be the first manual test you run.**

### What are we testing?

Whether someone working at **Riverside Annexe** can download a **Main Branch** patient's report file
— the actual PDF — by asking for it directly.

### Why are we testing it?

Because it was broken until 2026-08-17 (defect **D10**), and because of _how_ it was broken: the
**list** of reports was already correctly filtered by branch, so the screen never showed the link.
Anybody clicking through the app would have concluded everything was fine while the API happily
served the file to whoever asked.

> **This is the least clickable row in the entire campaign.** It cannot be done through the UI. It
> has to be probed directly with `curl`. That is not a shortcut — it is the only way to see it.

### Who performs it?

**Nurse A** (`nurse@sunrise.test`) — she holds `emr:read` and `file:read`, and she is hospital-wide,
so she can legitimately be "at" branch B.

### Starting state

- Tenant `sunrise`.
- A lab or radiology order at **branch A** with a report uploaded against it.
- `pnpm seed:validation -- --verify` says READY.

> **If no report exists yet:** create one first. As the **Doctor**, order a lab test on a branch-A
> patient (this is JR-09); as the **Lab tech**, accept → start → complete it and upload a result
> file; as the **Pathologist**, verify → release. If you cannot produce a report file, record BR-10
> as **BLOCKED — no report fixture** and say so. Do not guess an id.

### Step by step

**1. Get a token as Nurse A and note your branch ids** — Recipe 1 (§5.4).

```bash
BASE=http://sunrise.localhost:4000
TOKEN=$(curl -s "$BASE/api/v1/auth/login" -X POST -H 'Content-Type: application/json' \
  -d '{"email":"nurse@sunrise.test","password":"123456"}' | jq -r '.data.accessToken')
curl -s "$BASE/api/v1/me/branches" -H "Authorization: Bearer $TOKEN" | jq '.data.branches'
```

Set `BRANCH_A` and `BRANCH_B` from that output.

**2. Find the report id — as a branch A user.** This is the legitimate view.

```bash
PATIENT=<the branch-A patient id>

curl -s "$BASE/api/v1/patients/$PATIENT/reports" \
  -H "Authorization: Bearer $TOKEN" -H "X-Active-Branch: $BRANCH_A" | jq
```

**Write down the report `id`.** Call it `REPORT`. This is the id you are about to try to steal.

**3. Now become a branch B user** — same person, different desk. Ask for the same patient's report
list:

```bash
curl -s "$BASE/api/v1/patients/$PATIENT/reports" \
  -H "Authorization: Bearer $TOKEN" -H "X-Active-Branch: $BRANCH_B" | jq
```

**Expected:** the id you noted **must not appear**.

**4. The actual test — ask for the file itself, from branch B, using the id you already know:**

```bash
curl -s -i "$BASE/api/v1/reports/$REPORT/file" \
  -H "Authorization: Bearer $TOKEN" -H "X-Active-Branch: $BRANCH_B" | head -20
```

**5. Read the first line of the output.** It is either `HTTP/1.1 404 Not Found` (correct) or
`HTTP/1.1 200 OK` (a P1 regression).

If it returned `200`, check whether real PDF bytes came back:

```bash
curl -s "$BASE/api/v1/reports/$REPORT/file" \
  -H "Authorization: Bearer $TOKEN" -H "X-Active-Branch: $BRANCH_B" | head -c 4
```

`%PDF` means it served the document. That is the disclosure.

**6. Check the fix is not over-applied.** Go back to branch A and open the same file:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/v1/reports/$REPORT/file" \
  -H "Authorization: Bearer $TOKEN" -H "X-Active-Branch: $BRANCH_A"
```

**Expected: `200`.** A refusal in **both** directions is the fix over-applied and is its own defect.

### Expected result (from the runbook, verbatim in substance)

> Step 1 omits it. Step 2 refuses — `404 HMS-GEN-404`. **A `200` returning PDF bytes is a P1
> regression.** The A user can still open it.

### PASS / FAIL / BLOCKED

|             |                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**    | Branch B's list omits the id **and** the branch-B file request returns `404 HMS-GEN-404` **and** the branch-A request still returns `200`. All three.                               |
| **FAIL**    | The branch-B file request returns `200` (**P1 — stop and report**), _or_ the id appears in branch B's list, _or_ branch A can no longer open it (fix over-applied — also a defect). |
| **BLOCKED** | No report file exists to test with, and you could not create one. Say so explicitly.                                                                                                |

### Evidence to record

- The full `curl -i` output of step 4 (status line, `HMS-` code, `traceId`).
- Step 3's list output, showing the id is absent.
- Step 6's `200`.
- The report id, patient id, both branch ids, timestamp.
- **If it returned 200:** the first bytes, and stop the campaign.

### Cleanup

**None.** You only read.

---

## 7. BR-11 — Cross-Branch Appointment Mutation

### What are we testing?

Whether someone at **Riverside Annexe** can **change** a **Main Branch** appointment — cancel it,
mark it no-show, or check the patient in.

### Why are we testing it?

This was defect **D9**: the only confirmed cross-branch **write** in the product. A read leaking is
bad. This one **changed another site's clinic list**. Fixed 2026-08-17.

### 🪤 Read this trap before you start

> **Before the fix, the FIRST call succeeded** (`200`, appointment cancelled) **and the next two
> returned `422`** — refused by the state machine, because the appointment was already cancelled.
>
> **A `422` looks exactly like a working boundary and is not one.** If you only look at the last two
> responses you will record a PASS over a live cross-branch write.
>
> This is why step 5 below — re-reading the appointment as a branch-A user — is the half that
> actually proves it.

### Who performs it?

The **Receptionist** (`reception@sunrise.test`). RECEPTIONIST holds `appointment:create`,
`appointment:read`, `appointment:update` and `appointment:cancel` (verified in
`packages/permissions/src/index.ts`), and is hospital-wide so can act "at" branch B.

### Starting state

An appointment booked at **branch A**, in state `requested` or `confirmed`. Note its id.

**To create one:** in the browser at `http://sunrise.localhost:3000`, sign in as the Receptionist,
confirm the top bar says **Main Branch**, go to **`/appointments`**, and book one for any seeded
patient. Note the appointment id (visible in the row's URL or via the API below).

### Step by step

**1. Token as the Receptionist, and branch ids:**

```bash
BASE=http://sunrise.localhost:4000
TOKEN=$(curl -s "$BASE/api/v1/auth/login" -X POST -H 'Content-Type: application/json' \
  -d '{"email":"reception@sunrise.test","password":"123456"}' | jq -r '.data.accessToken')
curl -s "$BASE/api/v1/me/branches" -H "Authorization: Bearer $TOKEN" | jq '.data.branches'
```

**2. Record the appointment's state BEFORE the attack, as a branch-A user.** This is your baseline —
without it, step 5 proves nothing.

```bash
APPT=<branch-A appointment id>

curl -s "$BASE/api/v1/appointments/$APPT" \
  -H "Authorization: Bearer $TOKEN" -H "X-Active-Branch: $BRANCH_A" | jq '.data.status'
```

**Write the answer down.** (e.g. `"confirmed"`.)

**3. The attack — all three transitions, from branch B:**

```bash
for OP in cancel no-show check-in; do
  printf '%-10s ' "$OP"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    "$BASE/api/v1/appointments/$APPT/$OP" \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-Active-Branch: $BRANCH_B" \
    -H 'Content-Type: application/json' -d '{}'
done
```

**4. Read all three numbers.** Expected: `404`, `404`, `404`.

> A `422` anywhere here is the **trap**. It means the state machine refused — which can mean the
> appointment was _already changed_. Do not stop at the status codes.

**5. 🔴 The half that proves it — re-read the appointment as a branch-A user:**

```bash
curl -s "$BASE/api/v1/appointments/$APPT" \
  -H "Authorization: Bearer $TOKEN" -H "X-Active-Branch: $BRANCH_A" | jq '.data.status'
```

**Expected: exactly the state you wrote down in step 2.** Unchanged.

**6. Also confirm on screen.** In the browser, still as the Receptionist, switch the top-bar branch
back to **Main Branch**, open `/appointments`, and confirm the appointment still reads as it did.

### Expected result (runbook)

> All three refuse — `404 HMS-GEN-404`. **Then re-read the appointment as an A user: it must still be
> in the state it started in.**

### PASS / FAIL / BLOCKED

|             |                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**    | All three returned `404 HMS-GEN-404` **and** the appointment's state in step 5 is identical to step 2.                                 |
| **FAIL**    | Any `2xx`; **or** any `422`; **or** the state in step 5 differs from step 2 by any amount. Any of these is a **P1 — stop and report.** |
| **BLOCKED** | No branch-A appointment could be created.                                                                                              |

### Evidence to record

- The three status codes, in order, with the operation names.
- **Step 2's status and step 5's status, side by side.** This is the evidence.
- Screenshot of `/appointments` at branch A afterwards.
- The appointment id, both branch ids, the account, the timestamp.

### Cleanup

**None if it passed** — nothing changed. **If it failed**, do not "put it back": the changed state is
your evidence. Capture it and stop.

---

## 8. BR-07 — Branch-Confined Nurse

> **Status in the runbook: BLOCKED** — because no branch-confined account exists yet. You unblock it
> by **creating an account**, not by changing code. That is what this section does first.
>
> **⚠️ Source inconsistency, preserved not resolved (§33-A).** Runbook §19.2's D1 row says
> _"BR-07 is no longer blocked: the branch-confined case is proven by test"_, while BR-07's own row
> and §22 item 3 both say it is blocked and _"empirically unproven through a UI"_. The safest reading
> — and the one this guide follows — is that the **automated** case is covered and the **manual**
> row is still blocked until you create the account. **Treat BR-07 as BLOCKED until you have created
> Nurse C**, then run it.

### Why this account matters more than any other

The 2026-08-17 audit found three cross-branch defects, and **every one lived on a path no test walked
with two branches configured**. A confined user is the case with the least coverage in the entire
product. The runbook calls unblocking it _"the single highest-value account in the campaign"_.

### 8.1 Create the branch-confined nurse

> **⚠️ Clarification (§33-B).** The runbook says _"via the roles UI"_. In the current web app the
> control is on the **Staff** page (`/staff`), not `/roles` — Staff is where a member's branch
> binding lives. The requirement is unchanged (**tenant admin creates a branch-confined nurse, no
> code change**); only the location is clarified. Verified in `apps/web/app/staff/page.tsx` on
> 2026-08-17.

1. Open `http://sunrise.localhost:3000` and sign in as **`admin@sunrise.test` / `123456`**
   (Tenant admin).
2. Go to **Staff** (`/staff`).
3. Click the control to add a staff member. The panel says _"A temporary password is generated and
   shown once."_
4. Fill in:
   - **Full name:** `Nurse Annexe` (synthetic — invent it, never a real person)
   - **Email:** `nurse3@sunrise.test`
   - **Role:** **NURSE**
5. Find the **"Branch access"** block. It appears **only because this hospital has more than one
   site**. It offers two radio buttons:
   - **All branches** — _"works across every site, and may switch between them"_
   - **Specific branches**
6. Select **"Specific branches"**. A checkbox list of branch names appears.
7. Tick **only Riverside Annexe** (Branch B). Leave **Main Branch** unticked.
8. Save.
9. 🔴 **A temporary password is displayed ONCE.** Copy it immediately into your notes. If you lose
   it, use **Reset password** on that staff row to generate another.

### 8.2 Verify the account really is confined

```bash
BASE=http://sunrise.localhost:4000
NURSE_C=$(curl -s "$BASE/api/v1/auth/login" -X POST -H 'Content-Type: application/json' \
  -d '{"email":"nurse3@sunrise.test","password":"<the temporary password>"}' | jq -r '.data.accessToken')

curl -s "$BASE/api/v1/me/branches" -H "Authorization: Bearer $NURSE_C" | jq '.data'
```

**Expected:** the `branches` array contains **only Riverside Annexe**, and `canAggregate` is `false`.

> **If login says the password must be changed** (`mustChangePassword`), sign in on the web at
> `http://sunrise.localhost:3000`, set a new password when prompted, and use that from then on. This
> is normal for a newly created staff account — not a defect. Record the new password in your notes.

> **If `me/branches` returns both branches**, the account was not confined. Go back to §8.1 step 6
> and check "Specific branches" was actually selected. Do not run the rest of BR-07 against a
> hospital-wide account — the result would mean nothing.

### 8.3 The test — Branch B allowed, Branch A denied

**A. Branch B works (the positive half).** Sign in to the web as Nurse C.

- The branch button in the top bar should show **Riverside Annexe** and offer **no other choice** —
  no "All branches", no Main Branch.
- Open `/ward`. **Expected:** Annexe Ward, **3** admitted patients.
- Open `/medication-round`. **Expected:** it loads, showing B's doses.

**B. Branch A is denied (the security half).** At the API, ask for branch A explicitly:

```bash
curl -s -i "$BASE/api/v1/encounters" \
  -H "Authorization: Bearer $NURSE_C" \
  -H "X-Active-Branch: $BRANCH_A" | head -12
```

**Expected:** the request does **not** return branch A's 42 patients. Either a refusal, or a result
scoped to the branches this user is actually bound to.

> **What "correct" means here, precisely:** a confined user must never be able to **exceed their own
> binding**. If the header is ignored and you get _your own_ branch's data, that is the documented
> fail-safe design (see BR-09 / defect D4) — record it as such. If you get **branch A's data**, that
> is a **P1 — stop and report immediately.**

**C. A named branch-A record is denied.** Take a branch-A patient id and encounter id you noted
earlier:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/v1/patients/<branch-A patient id>" \
  -H "Authorization: Bearer $NURSE_C" -H "X-Active-Branch: $BRANCH_A"

curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/v1/encounters/<branch-A encounter id>" \
  -H "Authorization: Bearer $NURSE_C" -H "X-Active-Branch: $BRANCH_A"
```

**Expected: `404`** on the encounter. (On the patient, remember §3.7: **patient identity is
tenant-wide by design** — a name resolving is not a leak. What must not resolve is the branch-A
**clinical record**.)

**D. A branch-A write is denied.** The most important half:

```bash
curl -s -i -X POST "$BASE/api/v1/encounters/<branch-A encounter id>/nursing-notes" \
  -H "Authorization: Bearer $NURSE_C" -H "X-Active-Branch: $BRANCH_A" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"note":"validation probe — should be refused"}' | head -12
```

**Expected: `404 HMS-GEN-404`.** Then confirm nothing was written:

```bash
mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
  db.wardNotes.countDocuments({ note: /validation probe/ })'
```

**Expected: `0`.**

### 8.4 Branch switching and stale data

Nurse C cannot switch (that is the point). Run the switching check with **Nurse A**, who is
hospital-wide:

1. Sign in as Nurse A. Confirm the top bar says **Main Branch**. Open `/medication-round`.
2. **Without leaving the page**, use the branch button to switch to **Riverside Annexe**.
3. **Expected:** the page repaints with B's data. **No row, name, bed or dose from Main Branch
   survives anywhere on screen.** The header and the data must always agree.
4. Switch back to **Main Branch**. **Expected:** A's data re-reads — not a cached frame, not a merge.

> **This is runbook BR-08 and WEB-20.** A header saying one site over another site's data is the
> original web defect this whole design exists to prevent. If you ever see it, screenshot it
> immediately — it is hard to reproduce.

### PASS / FAIL / BLOCKED

|             |                                                                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**    | Nurse C sees only Riverside Annexe, cannot switch, gets B's ward (3 patients), and is refused a named branch-A encounter **and** a branch-A write (with `0` rows written). Plus §8.4's switch is clean in both directions. |
| **FAIL**    | Nurse C reaches any branch-A clinical record or writes anything to branch A → **P1, stop and report.** Or the branch switch leaves stale data on screen.                                                                   |
| **BLOCKED** | You could not create the confined account. Record exactly where it stopped.                                                                                                                                                |

### Evidence to record

- Screenshot of the Staff form showing **"Specific branches"** with only Riverside Annexe ticked.
- `me/branches` output for Nurse C (one branch, `canAggregate: false`).
- Screenshot of the top bar showing no switcher choice.
- All four `curl` outputs from §8.3 with their status codes and `HMS-` codes.
- The `wardNotes` count of `0`.
- Before/after screenshots for §8.4.

### Cleanup

Leave Nurse C in place — later sections reuse it, and it is a synthetic account in a test tenant.
Record its email and password in your notes. **Do not delete it** without saying so in your results.

---

## 9. TEN-01 — Tenant Isolation

### First, be clear what is different here

- **Branch** isolation = scoping inside **one** hospital's database.
- **Tenant** isolation = **two entirely separate databases** (ADR-0005).

A branch leak is serious. **A tenant leak is a P0 — stop the campaign and report immediately.**

### Who performs it?

Any account. The runbook says "Any". Use the **Tenant admin of `district`** for the strongest test:
the most privileged user in the _other_ hospital. `pnpm seed:demo` creates `admin@district.test`.

### Step by step

**1. Note a `sunrise` patient's name and UHID**, and a `sunrise` patient id and encounter id, from
your earlier work.

**2. Sign in to the other hospital in the browser:** `http://district.localhost:3000`, as
`admin@district.test` / `123456`.

> Notice you did not choose a hospital anywhere. **The URL was the choice.**

**3. Search for the `sunrise` patient by name.** Go to `/patients` and type the name.
**Expected: nothing found.**

**4. Search by UHID.** **Expected: nothing found.**

**5. Now try the ids directly at the API** — the part a screen cannot do:

```bash
DBASE=http://district.localhost:4000
DTOKEN=$(curl -s "$DBASE/api/v1/auth/login" -X POST -H 'Content-Type: application/json' \
  -d '{"email":"admin@district.test","password":"123456"}' | jq -r '.data.accessToken')

curl -s -o /dev/null -w 'patient   %{http_code}\n' "$DBASE/api/v1/patients/<sunrise patient id>" \
  -H "Authorization: Bearer $DTOKEN"
curl -s -o /dev/null -w 'encounter %{http_code}\n' "$DBASE/api/v1/encounters/<sunrise encounter id>" \
  -H "Authorization: Bearer $DTOKEN"
```

**Expected: `404` for both.** Nothing found, nothing served.

**6. Confirm no PHI leaked into the error.** Print the whole body:

```bash
curl -s "$DBASE/api/v1/patients/<sunrise patient id>" -H "Authorization: Bearer $DTOKEN" | jq
```

**Expected:** a plain refusal envelope. **No patient name, no UHID, no drug, no diagnosis** anywhere
in it — not even in `details`.

**7. Confirm nothing was mutated.** In the `sunrise` database, the patient is untouched:

```bash
mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
  db.patients.countDocuments({})'
```

Compare with a count you take before step 5. **Identical.**

**8. Sanity check the other direction** — that `district` is a real, working hospital and not just
empty. Open `/patients` in `district` and confirm its own patients are there. A test that passes
because the second tenant is empty proves nothing.

### Expected result (runbook)

> **Nothing is found, and nothing is served.** Different database entirely (ADR-0005). Any leak is a
> **P0 — stop the campaign and report immediately.**

### PASS / FAIL / BLOCKED

|             |                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**    | Name search, UHID search and both direct-id calls all return nothing; error bodies carry no PHI; counts unchanged; and `district` demonstrably has its own data. |
| **FAIL**    | **Anything** from `sunrise` is visible or reachable from `district`. **P0. Stop the entire campaign and report.**                                                |
| **BLOCKED** | The `district` tenant does not exist — re-run `pnpm seed:demo`.                                                                                                  |

### Evidence to record

- Screenshots of both searches returning nothing.
- Both status codes from step 5.
- The full error body from step 6 (proving no PHI).
- The before/after patient counts.
- A screenshot from step 8 showing `district` has its own patients.

### Cleanup

**None.** You only read.

---

## 10. BR-12 — Wallet Advance Is Hospital-Wide (a NEGATIVE check)

### Read this before you run it

**This test passes when data crosses branches.** It is here so that nobody "fixes" a boundary that is
supposed to be open.

A patient has **one** advance-payment purse for the whole hospital. Money paid in at Main Branch is
spendable at Riverside Annexe. That is a deliberate product decision, documented in runbook §11.1.

> **This exact read was "fixed" to be branch-scoped during the 2026-08-17 audit and then reverted**
> once someone read the account model. **A refusal here is a defect, not a security improvement.**

### Who performs it?

The **Cashier** (`cashier@sunrise.test`).

### Step by step

1. Sign in to the web as the Cashier. Confirm the top bar says **Main Branch**.
2. Open the patient's wallet and **take an advance** (any small synthetic amount).
3. **Note the wallet entry id** for the deposit.
4. Switch the top-bar branch to **Riverside Annexe**.
5. Open the **same patient's** wallet.
6. **Reprint the receipt** for the branch-A deposit:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/v1/wallet/entries/<entry id>" \
  -H "Authorization: Bearer $TOKEN" -H "X-Active-Branch: $BRANCH_B"
```

### Expected result (runbook)

> Balance and statement show the A deposit; the receipt reprints, `200`. **A refusal here is a
> defect**, not a security improvement.

### PASS / FAIL / BLOCKED

|             |                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**    | From branch B, the balance and statement show the branch-A deposit, and the receipt reprints with `200`.                                                                                                                                           |
| **FAIL**    | The deposit is missing from the statement at branch B, **or** the receipt returns `403`/`404`. Report it as _"hospital-wide wallet read has been branch-scoped — see runbook §11.1 and BR-12"_. **Do not report it as a branch-isolation defect.** |
| **BLOCKED** | The wallet feature is not reachable for this account.                                                                                                                                                                                              |

> **The specific failure this row is watching for:** a statement that lists a line whose receipt will
> not open. That combination — visible in the list, refused on click — is the shape of a
> half-applied "fix".

### Evidence

Screenshots of the wallet at both branches, and the `200` from the receipt call.

### Cleanup

The advance stays on the synthetic patient. Note it in your results so a later billing row is not
confused by an unexplained balance.

---

# PART B — SCHEMA DRIFT / RUNTIME SAFETY

## 11. What Is Schema Drift?

### The idea, in plain language

Some clinical rules are not enforced by the application code. They are enforced by the **database
itself**, with something called a **unique index** — a rule the database will not let you break, no
matter which screen or which server asked.

For example: _"the same scheduled dose cannot be charted twice."_ That is a database rule.

**Schema drift** is when that rule goes missing — restored from an old backup, dropped by hand during
maintenance, a migration that never ran on one hospital.

### Why that is dangerous

Without the rule, the application would carry on happily, and **two nurses could chart the same dose
and nothing would stop them.** The screen would look completely normal.

This is not hypothetical. On 2026-08-14 a probe against four local hospitals reported **seven
catastrophic safety failures**. Every one of them was a **missing index**, not a code defect.

### What the product does about it

Five clinical writes now **check that the rule is armed before they write**. If it is not, they
refuse — with a `503` and a message that tells the clinician what to do on paper:

| Write                  | Error code    | What it tells the clinician |
| ---------------------- | ------------- | --------------------------- |
| Chart a dose (MAR)     | `HMS-MAR-002` | chart on **paper**          |
| Hand over drugs        | `HMS-PHM-004` | hand over on **paper**      |
| Place an order         | `HMS-ORD-001` | order on **paper**          |
| Admit / transfer a bed | `HMS-ADM-003` | allocate on **the board**   |
| Start a visit          | `HMS-ENC-001` | register on **paper**       |

### What `503` and `Retry-After` mean here

- **`503`** = _"the service cannot safely do this right now."_ It is deliberately **not** a `500`
  (a crash) and **not** a `400` (your fault). Nothing is wrong with what you asked — the system
  cannot guarantee it can do it safely.
- **`Retry-After: 60`** = _"ask again in 60 seconds."_ The readiness check is cached for 60 seconds,
  so after an operator repairs the index it can take up to a minute for the system to notice. **That
  wait is itself part of DRIFT-07.**

### Why unrelated things must keep working — "proportionality"

This is the point of the whole section, and it is the row most likely to find something real.

When the **dose-charting** rule is missing, charting a dose must be refused — **and recording vitals
and writing a nursing note must still work.** A ward that cannot record a patient's blood pressure
because a _medication_ index is missing is a system that has made itself dangerous in a new way.

**An over-block is a P0, not an inconvenience.** DRIFT-02, DRIFT-04, DRIFT-05 and DRIFT-06 each check
that the refusal stayed inside its own lane.

### ⚠️ Before you drop anything

- **Use the validation tenant only** (`sunrise`, or whatever slug you seeded). Never any other.
- **Put the index back inside the same session.** A validation session that leaves a ward drifted is
  **worse than one that never ran**.
- **`pnpm seed:migrate` will NOT put a dropped index back.** See §11.2 — this is the single easiest
  way to end a session having quietly disarmed a ward.
- Every clinical result taken against a drifted tenant afterwards is **void**.

### 11.1 The DROP commands — copy exactly

Mongo is on port **37018** in this environment. Replace `<slug>` with `sunrise`.

**Drop exactly one at a time**, run the test, then restore it before moving to the next row.

```bash
# DROP (one of). Mongo is on port 37018 in this dev environment.
mongosh "mongodb://localhost:37018/hms_<slug>" --quiet --eval '
  db.medicationAdministrations.dropIndex("one_administration_per_dose_slot")'  # MAR
  # db.dispenses.dropIndex("one_dispense_per_request_id")                      # dispensing
  # db.orders.dropIndex("one_order_per_request_id")                            # ordering
  # db.encounters.dropIndex("one_open_stay_per_bed_per_branch")                # bed assignment
  # db.encounters.dropIndex("one_open_encounter_per_patient")                  # starting a visit
```

To drop a different one, uncomment that line's command and run it in place of the first.

### 11.2 ⚠️ Restoring: the obvious command does NOT work, and it fails silently

> **`pnpm seed:migrate` will NOT put a dropped index back.** The migration runner skips any migration
> already listed in the tenant's `migrations` collection, and dropping an index does not remove its
> record. So the migration is skipped, the CLI reports **"tenant converged"**, and the database is
> exactly as unsafe as it was.
>
> This is measured, not theorised — it was recorded against a real tenant on 2026-08-14
> (`migrationsApplied: []`, index still absent).

**Restore by recreating the index you dropped.** The gate checks the index's **shape**, not its name,
so these must match field-for-field and in this order. Running the whole block is safe — recreating
an index that is already there is a no-op, and it is the simplest way to be certain you put back
whatever you dropped.

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

**Then confirm with the deployment gate — this is not optional:**

```bash
pnpm --silent seed:migrate --check --json | jq '.verdict'    # must print "READY"
```

`NOT_READY` with code `schema_drift` means the index is still absent. **Do not continue until this
prints `READY`.**

### 11.3 The recovery ritual — identical for every DRIFT row

Memorise this. It is the same five steps every single time, and it is the one thing not to improvise:

1. **Recreate** the index (the block in §11.2).
2. **Wait up to 60 seconds** for the readiness cache to expire.
3. **Retry the same clinical action.** It must now succeed.
4. `pnpm --silent seed:migrate --check --json | jq '.verdict'` → must print `"READY"`.
5. Record it.

**If step 3 needs an API restart, that is DRIFT-07 failing, and it is a P1.**

### 11.4 The universal DRIFT shape

Every row below follows the same six steps:

|       |                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------- |
| **1** | **Count first.** Run the Mongo count from the row's table. Write the number down.                 |
| **2** | **Drop** the one index named in the row.                                                          |
| **3** | **Attempt the action**, as the exact account the row names.                                       |
| **4** | **Observe the refusal** — status, `HMS-` code, `Retry-After` header, and what the screen says.    |
| **5** | **Count again.** It must be identical to step 1. _(This is DRIFT-09, and it is the whole point.)_ |
| **6** | **Recover** — §11.3, all five steps.                                                              |

**Tenant is `sunrise` and branch is A (Main Branch) for every row except DRIFT-08.**

---

## 12. DRIFT-01 — MAR (charting a dose)

|                      |                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Who**              | **Nurse A** — holds `mar:administer`                                                                                   |
| **Prerequisite**     | A **due, unanswered scheduled** dose. Note `prescriptionId`, `lineIndex`, `scheduledFor` **before** you drop anything. |
| **Index to drop**    | `medicationAdministrations` → `one_administration_per_dose_slot`                                                       |
| **Expected HTTP**    | `503 HMS-MAR-002` + header `Retry-After: 60`                                                                           |
| **Count afterwards** | `medicationAdministrations.countDocuments({prescriptionId, lineIndex, scheduledFor})` → **0**                          |

### Step by step

**1. Find a due scheduled dose and note its three identifiers.** In the browser as Nurse A, open
`/medication-round`, pick a due dose and open its confirmation screen — or at the API:

```bash
curl -s "$BASE/api/v1/encounters/<encounter id>/medication-schedule" \
  -H "Authorization: Bearer $TOKEN" -H "X-Active-Branch: $BRANCH_A" | jq
```

Write down `prescriptionId`, `lineIndex` and `scheduledFor`.

> **Use a SCHEDULED dose, not an SOS/PRN one.** PRN doses are deliberately unconstrained — the index
> does not cover them, so dropping it would change nothing and you would record a false FAIL.

**2. Count before:**

```bash
mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
  db.medicationAdministrations.countDocuments({
    prescriptionId: "<RX>", lineIndex: <N>, scheduledFor: "<ISO>" })'
```

**3. Drop the index** (§11.1, first line).

**4. Attempt to chart the dose.** On the web at `/medication-round`, select that dose and press
**Give**. (Or at the API with the §15.3-style call.)

**5. Expected:**

- HTTP **`503`**, error code **`HMS-MAR-002`**, header **`Retry-After: 60`**.
- The message **names paper** — it tells the nurse to chart on paper.
- 📸 **Photograph the screen.** This is the row's whole purpose: a nurse must be able to tell this
  from "no signal".

**6. Count again → must be `0`.** Nothing was written.

**7. Recover** — §11.3.

### PASS / FAIL / BLOCKED

- **PASS** — `503 HMS-MAR-002` with `Retry-After`, the screen names paper, count is `0`, and
  recovery works within 60s without a restart.
- **FAIL** — the dose is **charted** (a row appears) → **P0, stop.** Or a `500`. Or the screen shows
  a generic error a nurse could not act on. Or recovery needs an API restart (that is DRIFT-07, P1).
- **BLOCKED** — no due unanswered scheduled dose exists. (See §5.1 on overdue doses being a clock
  state.)

### Evidence

Screenshot of the nurse's screen · full response with headers · both counts · the `--check` verdict
after recovery.

### Cleanup

**Mandatory** — §11.3. Do not move on until `--check` prints `READY`.

---

## 13. DRIFT-02 — Proportionality (the most important row in Part B)

### Why this matters clinically

The dose-charting rule is missing, so charting a dose is refused. **Recording vitals and writing a
nursing note have nothing to do with that rule and must still work.**

If they are blocked too, the ward cannot record a deteriorating patient's blood pressure because of a
_medication_ index. **That is a P0 over-block** — the system has made itself dangerous in a new way
while trying to be safe.

|                      |                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------- |
| **Who**              | **Nurse A** — holds `vitals:record` and `nursing:manage`                            |
| **Prerequisite**     | Any admitted patient in branch A. **The MAR index from DRIFT-01 is still dropped.** |
| **Expected HTTP**    | **`201` for both**                                                                  |
| **Count afterwards** | one `vitals` row, one `wardNotes` row → **each 1**                                  |

### Step by step

Run this **while the MAR index is still dropped** — immediately after DRIFT-01, before recovering.

**1. Confirm the MAR refusal is still live.** Re-attempt the dose. Still `503 HMS-MAR-002`. Good —
the drift is in place.

**2. Record a full set of vitals** on an admitted branch-A patient, on the web.
**Expected: `201`.** It saves. The chart shows the reading with the ward's time.

**3. Write a nursing note** on the same patient. **Expected: `201`.** It appears on the timeline,
attributed to you.

**4. Count both:**

```bash
mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
  print("vitals:    " + db.vitals.countDocuments({ encounterId: "<ENC>" }));
  print("wardNotes: " + db.wardNotes.countDocuments({ encounterId: "<ENC>" }));'
```

**Expected: 1 and 1.**

**5. Now recover the MAR index** (§11.3) and confirm charting works again — that is DRIFT-07.

### PASS / FAIL

- **PASS** — both writes returned `201` and both rows exist, while MAR was still refusing.
- **FAIL** — **either** write is blocked → **P0 over-block.** Stop, capture the exact status and
  code, and report. This is more serious than the refusal being tested.

### Evidence

The still-live `503` from step 1 · both `201`s · both counts · screenshots of the saved vitals and
the note on the timeline.

---

## 14. DRIFT-03 — Dispensing

> ⚠️ **You MUST use the Pharmacist.** `pharmacy@sunrise.test` is the **only** role holding
> `pharmacy:dispense`. A nurse or a doctor attempting this gets `403 HMS-AUTH-005` — which means
> **wrong account**, not a defect, and is **not the refusal this row is testing**.

|                      |                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| **Who**              | **Pharmacist** (`pharmacy@sunrise.test`)                                                         |
| **Prerequisite**     | A **signed** prescription with quantity still outstanding                                        |
| **Index to drop**    | `dispenses` → `one_dispense_per_request_id`                                                      |
| **Expected HTTP**    | `503 HMS-PHM-004`                                                                                |
| **Count afterwards** | `dispenses.countDocuments({prescriptionId})` **unchanged**; `lines[].dispensedQty` **unchanged** |

### Step by step

1. **Count before:**
   ```bash
   mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
     db.dispenses.countDocuments({ prescriptionId: "<RX>" })'
   ```
   Also note the prescription's `dispensedQty`.
2. **Drop** `one_dispense_per_request_id` (§11.1).
3. Sign in to the web as the **Pharmacist**. Open **`/pharmacy`**. Hand over against that
   prescription.
4. **Expected: `503 HMS-PHM-004`.**
5. **Also check MAR charting still works** — two capabilities, one tenant, independent. As Nurse A,
   chart a due dose. **Expected: it succeeds.** If it is blocked, that is an over-block (P0).
6. **Count again — unchanged.** `dispensedQty` unchanged.
7. **Recover** — §11.3.

### PASS / FAIL / BLOCKED

- **PASS** — `503 HMS-PHM-004`, dispense count and `dispensedQty` unchanged, MAR still works.
- **FAIL** — the handover succeeds; or `dispensedQty` moved; or MAR charting was blocked too (P0).
- **BLOCKED** — no signed prescription with outstanding quantity. Sign one first (that is JR-11).

**If you see `403 HMS-AUTH-005`:** you are signed in as the wrong person. Re-read the ⚠️ above.

---

## 15. DRIFT-04 — Ordering

> ⚠️ **Three people, on purpose.** The **Doctor** places the order. The **Lab tech** accepts/starts/
> completes. The **Pathologist** verifies/releases. The state machine treats one person doing both
> halves as a **patient-safety failure**, not a convenience. Two logins are required, and a `403`
> means wrong account.

|                      |                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **Who**              | **Doctor** places · **Lab tech** then **Pathologist** move existing work                  |
| **Prerequisite**     | An open encounter to order against, **and** an order already on the bench to push through |
| **Index to drop**    | `orders` → `one_order_per_request_id`                                                     |
| **Expected HTTP**    | Place → `503 HMS-ORD-001` · accept / start / complete / verify / release → `200`          |
| **Count afterwards** | `orders.countDocuments({encounterId})` **unchanged** by the refused placement             |

### Why the lab keeps working

Work already on the bench must not be stranded mid-analysis. A sample in a machine cannot wait for an
index. **The state machine is deliberately unguarded** — only _placing a new order_ is refused.

### Step by step

1. **Before dropping:** place an order and push it partway through so there is work on the bench.
   (Doctor orders → Lab tech accepts → starts.)
2. **Count before:**
   ```bash
   mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
     db.orders.countDocuments({ encounterId: "<ENC>" })'
   ```
3. **Drop** `one_order_per_request_id`.
4. As the **Doctor**, place a new lab test. **Expected: `503 HMS-ORD-001`.**
5. As the **Lab tech**, on the order already on the bench: **complete** it. **Expected: `200`.**
6. As the **Pathologist**, **verify** then **release** it. **Expected: `200` for both.**
7. **Count again — unchanged** by the refused placement.
8. **Recover** — §11.3.

### PASS / FAIL

- **PASS** — placement `503 HMS-ORD-001`, order count unchanged, and every existing-work transition
  returned `200`.
- **FAIL** — the placement succeeded; **or** any bench transition was blocked (that strands a sample
  — report as an over-block).

---

## 16. DRIFT-05 — Bed Occupancy (admission AND transfer)

> ⚠️ **Two roles.** Admitting is `admission:create` → **DOCTOR**. Moving a bed is `bed:allocate` →
> **NURSE**. One login cannot do both halves.

|                      |                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Who**              | **Doctor** admits · **Nurse A** transfers                                                                                     |
| **Prerequisite**     | An **open OP encounter**, and a **free bed** (the seed leaves 3 free of `GW-1…GW-45`)                                         |
| **Index to drop**    | `encounters` → `one_open_stay_per_bed_per_branch`                                                                             |
| **Expected HTTP**    | **Both** `503 HMS-ADM-003`                                                                                                    |
| **Count afterwards** | `encounters.countDocuments({class:"IP", open:true})` **unchanged**; the OP encounter still `open:true` and **not** `admitted` |

### Why discharge must keep working

**A ward that can neither admit nor discharge simply fills up.** Discharge is deliberately unguarded.

### Step by step

1. **Count before:**
   ```bash
   mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
     db.encounters.countDocuments({ class: "IP", open: true })'
   ```
2. **Drop** `one_open_stay_per_bed_per_branch`.
3. **Half A — admission.** As the **Doctor**, from `/my-patients`, admit a patient to a free bed in
   General Ward. **Expected: `503 HMS-ADM-003`.**
4. **Half B — transfer.** As **Nurse A**, on `/ward`, use **"Move bed"** to move an already-admitted
   patient to a free bed. **Expected: `503 HMS-ADM-003`.**
5. **Check discharge still works.** As the **Doctor**, discharge an admitted patient.
   **Expected: it succeeds.** Also confirm the **bed board still loads**.
6. **Count again — unchanged.** And check the OP encounter you tried to admit:
   ```bash
   mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
     db.encounters.findOne({ _id: ObjectId("<OP ENCOUNTER ID>") }, { open: 1, status: 1, class: 1 })'
   ```
   **Expected: still `open: true`, and NOT `admitted`.** This is the important one — a half-applied
   admission would leave the outpatient visit closed with no inpatient stay to show for it.
7. **Recover** — §11.3.

### PASS / FAIL

- **PASS** — both halves `503 HMS-ADM-003`; IP count unchanged; the OP encounter still open and not
  `admitted`; discharge still works; bed board loads.
- **FAIL** — either half succeeds; **or** the OP encounter changed state; **or** discharge was
  blocked (over-block, P0); **or** the bed board fails to load.

**If you see `403`:** wrong role for that half. Re-read the ⚠️ above.

---

## 17. DRIFT-06 — Open Encounter (starting a visit)

|                      |                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Who**              | **Receptionist** — `encounter:create`                                                                                                   |
| **Prerequisite**     | A patient with **no open encounter** — register a fresh walk-in. _(All 42 admitted patients already have one, so they cannot be used.)_ |
| **Index to drop**    | `encounters` → `one_open_encounter_per_patient`                                                                                         |
| **Expected HTTP**    | `503 HMS-ENC-001`                                                                                                                       |
| **Count afterwards** | `encounters.countDocuments({patientId, open:true})` → **0**                                                                             |

### Step by step

1. As the **Receptionist**, register a fresh synthetic patient at `/patients`. Note the patient id.
   **Do not start a visit yet.**
2. **Count before** — should be `0`:
   ```bash
   mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
     db.encounters.countDocuments({ patientId: "<PATIENT>", open: true })'
   ```
3. **Drop** `one_open_encounter_per_patient`.
4. On `/reception`, **start a visit** for that patient. **Expected: `503 HMS-ENC-001`.**
5. **Also check the appointment desk's check-in** — it reaches the same guard. Book an appointment
   for another patient and **check them in**. **Expected: the same `503 HMS-ENC-001`.**
6. **Check patients already in the queue can still be called in and closed.** As the Doctor, call in
   a patient whose visit started _before_ the drop, and close it. **Expected: both work.**
7. **Count again → `0`.**
8. **Recover** — §11.3.

### PASS / FAIL

- **PASS** — both entry points `503 HMS-ENC-001`, count `0`, and existing queue traffic still moves.
- **FAIL** — a visit is created; or existing patients can no longer be called in or closed
  (over-block, P0); or check-in behaves differently from reception (that is a hole in the guard).

---

## 18. DRIFT-07 … DRIFT-12

These are the rows that check the _system around_ the refusals. The IDs and definitions are exactly
as the runbook states them.

### DRIFT-07 — Recovery

|                  |                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------- |
| **Purpose**      | Restoring the index restores the capability, with no restart                                |
| **Who**          | Whoever ran the refused act                                                                 |
| **Prerequisite** | The index recreated per §11.2                                                               |
| **Steps**        | Restore any dropped index → **wait up to 60 s** → retry the same action                     |
| **Expected**     | **Succeeds. No restart, no cache flush, no redeploy.** The original `2xx`.                  |
| **Count**        | The row now exists — **1**                                                                  |
| **PASS**         | The retry succeeds within 60 seconds of the index being restored, with nothing restarted    |
| **FAIL**         | 🔴 **If it needs an API restart, that is a P1 finding.** Record exactly what you had to do. |
| **Evidence**     | The time you restored the index, the time the retry succeeded, and the `--check` verdict    |

> **Do not shorten the wait by restarting the API.** The 60 seconds _is_ the test. Restarting hides
> the very thing being measured.

### DRIFT-08 — Second hospital (tenant isolation under drift)

|                  |                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| **Purpose**      | One hospital's drift must not affect another's                                                                |
| **Who**          | The same act, in tenant **`district`**                                                                        |
| **Prerequisite** | `district` converged (§2.5 covers the fleet); `sunrise` currently drifted                                     |
| **Steps**        | With `sunrise` still drifted, perform the same clinical act in `district` at `http://district.localhost:3000` |
| **Expected**     | **Works normally throughout.** Normal `2xx`.                                                                  |
| **Count**        | Written normally in `hms_district`; `hms_sunrise` still refusing                                              |
| **PASS**         | The act succeeds in `district` while still being refused in `sunrise`                                         |
| **FAIL**         | 🔴 **A cross-tenant block is a P0.** One hospital's maintenance must never stop another's.                    |
| **Evidence**     | Both responses side by side, with the tenant named on each                                                    |

### DRIFT-09 — Nothing was written

|              |                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**  | _"A refusal leaves nothing to reconcile."_ This is the property the whole design rests on.                                                    |
| **Steps**    | After **any** DRIFT refusal, re-read the chart / worklist                                                                                     |
| **Expected** | No dose, no dispense, no order, no admission, no encounter. **The OP encounter in DRIFT-05 is still open, not `admitted`.** Re-read is `200`. |
| **Count**    | **Every count in §12–§17 is the "nothing happened" value.**                                                                                   |
| **PASS**     | Every count after a refusal equals the count before it, and the UI agrees                                                                     |
| **FAIL**     | Any count moved → the refusal was not clean. Report with both numbers.                                                                        |

> **You have already been doing this** — step 5 of §11.4 is DRIFT-09. Record it as its own row using
> the counts you collected.

### DRIFT-10 — Mobile (the row most likely to find something real)

|              |                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------- |
| **Purpose**  | Repeat **DRIFT-01** on the handset                                                            |
| **Who**      | **Nurse A**, on a real phone                                                                  |
| **Expected** | **The dose is NOT shown as given.**                                                           |
| **PASS**     | The nurse is not told the dose was recorded                                                   |
| **FAIL**     | The phone shows the dose as **given** → the screen contradicts the database. Stop and report. |

**What "correct" looks like on the phone.** The app classifies a `503` as **`unknown`** — it re-reads
the slot, sees it is still due, and reports that it **could not confirm**. That is **safe**: it never
shows the dose as given.

**Record what the nurse actually sees, and judge it against one question:**

> _Would a nurse holding this phone know the dose was NOT recorded, and know to chart on paper?_

- If **yes** → PASS.
- If _"she would know it failed but not what to do"_ → record a **P2 UX finding against the
  classifier**, **not** a safety failure. The write provably did not happen.
- **Do not work around it in the field.**

### DRIFT-11 — Server log

|              |                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**  | An operator must be able to act **without asking a clinician to read a screen**                                            |
| **Steps**    | While any DRIFT test runs, watch the API terminal (the `pnpm dev` window)                                                  |
| **Expected** | **One `error` line per refusal**, carrying `code`, `status`, `tenant`, `traceId`, and **the missing rule + its migration** |
| **PASS**     | The line is there and names the missing index and migration                                                                |
| **FAIL**     | No log line, or a line that does not say which rule is missing                                                             |
| **Evidence** | Copy the log line into your results (after checking DRIFT-12)                                                              |

**How to watch it:** keep the `pnpm dev` terminal visible while you press the button. The line appears
the moment the refusal is sent.

### DRIFT-12 — PHI check on the same log lines

|              |                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------- |
| **Purpose**  | The refusal is logged; the **patient** is not                                                 |
| **Steps**    | Read the same log lines from DRIFT-11                                                         |
| **Expected** | **No patient name, UHID, encounter id, prescription id or drug** anywhere in the refusal line |
| **PASS**     | The line names the rule and the tenant and nothing about a person                             |
| **FAIL**     | Any patient-identifying value in the line → a PHI-in-logs defect. Report it.                  |
| **Evidence** | The log line, **quoted in full**, so the absence is on the record                             |

> This is asserted by `errorContract.test.ts` in CI, but **confirm it in a real log once.** That is
> what this row is for.

### ⚠️ End-of-Part-B checklist

```
[ ] Every index dropped during Part B has been recreated
[ ] pnpm --silent seed:migrate --check --json | jq '.verdict'  printed "READY"
[ ] pnpm seed:validation -- --verify  printed READY
[ ] Every DRIFT count recorded, before and after
```

**Do not start Part C until all four are ticked.** Everything after this point is void otherwise.

---

# PART C — CLINICAL JOURNEY VALIDATION

## 19. §13A — JR-01 … JR-22, DUP-01, DUP-02, TEN-01

### What is a journey test?

Everything so far tested one thing in isolation. A **journey test** follows **one patient** from the
moment they walk in the front door to the moment they pay the bill — through **seven different
members of staff**.

It is the only place in this campaign where **a failure legitimately blocks the next step**. That is
deliberate: if registration is broken, there is no honest way to test billing.

### Why it exists

§13 (Part D) covers **two web pages out of forty-four**. Until 2026-08-17, registration, reception,
appointments, consultation, ordering, dispensing, admission, bed transfer, discharge and billing had
**no manual test row at all**. This section closes that gap. **None of these rows has ever been
executed.**

### Ground rules

|                    |                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tenant**         | `sunrise`                                                                                                                                    |
| **Branch**         | **A (Main Branch)** — the whole journey, start to finish                                                                                     |
| **When to run it** | **After Part A and after §22 (permissions), and BEFORE the mobile sections**                                                                 |
| **Patient**        | **One** synthetic patient you create in JR-01. Write the name and UHID at the top of your results page — you will need them for twenty rows. |

> ⚠️ **Do NOT run the journey across two branches.** A patient registered at branch B cannot be
> opened from branch A. That is **recorded technical debt and a PRODUCT DECISION**, not a defect —
> ADR-0015 §5 says patient lookup is tenant-wide, the repository scopes it to a branch, and doing
> neither is the only certainly-wrong option. **Record it against this note and move on.**

### 🔴 Irreversible actions — you will be warned before each

These cannot be undone on a synthetic patient without re-seeding. **The guide flags each one before
the step.**

| Step      | What becomes permanent                          |
| --------- | ----------------------------------------------- |
| **JR-11** | **Signing** a prescription — a medico-legal act |
| **JR-12** | **Dispensing** — stock decrements               |
| **JR-13** | **Admission** — the OP visit closes permanently |
| **JR-15** | **Bed transfer**                                |
| **JR-18** | **Discharge** — the stay closes                 |
| **JR-21** | **Finalizing a bill and taking payment**        |

**Before each, capture your evidence for the previous step.** You cannot go back for it.

### How to switch user

Between rows the person changes. Each time:

1. Sign out (top-right menu).
2. Sign in as the account the row names.
3. **Check the branch button says "Main Branch"** before you do anything.
4. Note the switch in your results — _who_ did _what_ is part of what is being tested.

> **Tip:** use two browser profiles (or one normal + one private window) to keep two people signed in
> at once. JR-06 and JR-10 need two identities anyway. **Never** run two roles in the same session by
> reusing one login.

---

### JR-01 · Register a new patient — **Receptionist**

- **Screen:** `/patients` → register
- **Action:** register a synthetic patient with an invented name and phone number
- **Expected:** `201`. **A UHID is issued and shown on screen.**
- **Concern:** No UHID on screen means the identity the whole record hangs from is invisible at the
  moment it is created.
- **Record:** name, UHID, patient id, timestamp. 📸 screenshot of the UHID.

### JR-02 · 🔴 MPI duplicate refusal — **Receptionist**

- **Action:** register a **second** patient with the **same name, DOB and phone**
- **Expected:** **`409 HMS-PAT-002`**, and the screen **names the candidate(s)** it thinks this
  already is, **with what matched**
- **Concern:** _"A silent second UHID is how one human becomes two charts."_ **This is a safety row,
  not a validation row.**
- **PASS** — the refusal appears and names the existing patient and the matching fields
- **FAIL** — a second UHID is issued; or the refusal appears but names nothing (a nurse cannot act on
  "duplicate detected")
- 📸 screenshot of the candidate list

### JR-03 · Deliberate override — **Receptionist**

- **Action:** on that refusal, choose to **register anyway** (`force`)
- **Expected:** it proceeds — **and only because a human said so**
- **Concern:** 🔴 **If `force` is applied automatically anywhere, that is a P1** — the duplicate check
  would be decorative
- **Watch for:** an override that happens without an explicit human click. If the second registration
  ever succeeds _without_ you choosing to override, stop and report.

### JR-04 · Patient lookup — **Receptionist**

- **Action:** search by **name**, then by **UHID**, then by **phone**
- **Expected:** **all three** find the patient
- **FAIL** — any one of the three fails to find them

### JR-05 · Start a visit — **Receptionist**

- **Screen:** `/reception`
- **Action:** start a visit for JR-01's patient
- **Expected:** `201`; **a token is issued**; the patient appears on the day's register
- **Record:** the token number and the encounter id

### JR-06 · 🔴 Start it again — **Receptionist**

- **Action:** start a visit for the **same patient** a second time
- **Expected:** **the same visit is handed back — resumed, not duplicated.** The register shows
  **one** row, **one** token.
- **Concern:** two open visits is _"the commonest data-quality disaster in an OPD"_ — the census
  double-counts and the bill splits in two.
- **Verify in the database:**
  ```bash
  mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
    db.encounters.countDocuments({ patientId: "<PATIENT>", open: true })'
  ```
  **Expected: `1`.**
- **FAIL** — two open encounters, or two tokens, or two register rows

### JR-07 · Appointment → the same door — **Receptionist**

- **Screen:** `/appointments`
- **Action:** book an appointment for the same patient, then **check in**
- **Expected:** check-in produces a visit **exactly as JR-05 did**, and **JR-06's rule still holds
  against it** — still one open visit
- **Concern:** check-in reaches the same underlying operation. If it can create a _second_ open
  visit, JR-06's guard has a hole.
- **Verify:** re-run the JR-06 count. Still **`1`**.

### JR-08 · Consultation — **Doctor** (`drrao@sunrise.test`)

> 🔁 **Switch user now.**

- **Screen:** `/my-patients`
- **Action:** call the token in, record the consultation
- **Expected:** saved against **that** encounter; the queue advances

### JR-09 · Order an investigation — **Doctor**

- **Action:** order a lab test from the consultation
- **Expected:** `201`; **it appears on the lab's worklist with no hand-off**
- **Concern:** if it does not reach the lab queue, the product's single-spine claim is not true
- **Record:** the order id
- **Note:** DUP-02 (below) is run **on this button** — do it now while you are here

### JR-10 · Perform, verify, release — **Lab tech**, then **Pathologist**

> 🔁 **Two different logins. This is not optional.**

- **As Lab tech** (`labtech@sunrise.test`): **accept → start → complete**
- **Then as Pathologist** (`pathologist@sunrise.test`): **verify → release**
- **Expected:** the **technician cannot verify**. Only after `released` does the result reach the
  ordering doctor.
- **Concern:** the same person doing both is a **patient-safety failure**, not a shortcut
- **Explicitly test it:** as the **Lab tech**, try to **verify**. **Expected: refused.** Record the
  status and code.
- **Record:** the report id — **BR-10 needs it** if you have not run BR-10 yet

### JR-11 · Prescribe and sign — **Doctor**

> 🔴 **IRREVERSIBLE — signing is a medico-legal act. Capture JR-10's evidence first.**

- **Action:** prescribe one of the seeded drugs; **sign** it
- **Expected:** an allergy or interaction finding presents as a **review step**, not a failed save
- **Concern:** _"An alert shaped like an error gets clicked past."_
- **Record:** the prescription id and its lines

### JR-12 · Dispense — **Pharmacist**

> 🔴 **IRREVERSIBLE — stock decrements.**
> 🔁 **Switch user.**

- **Screen:** `/pharmacy`
- **Action:** hand over against that prescription
- **Expected:** `201`; **`dispensedQty` rises**; the drug charge appears on the bill **shortly
  after**, not instantly — billing listens for an event
- **Concern:** a charge that never arrives is money the hospital loses silently
- **Wait and re-check the bill** before recording a FAIL — "shortly after" is expected behaviour
- **Note:** DUP-01 (below) is run **on this button** — do it now

### JR-13 · Admit — **Doctor**

> 🔴 **IRREVERSIBLE — the OP visit closes permanently.**
> 🔁 **Switch user.**

- **Screen:** `/my-patients` → admit to a **free bed in General Ward**
- **Expected:** `201`. The OP visit becomes **`admitted`** (a terminal state) and an **IP** encounter
  opens **in the same episode**. The patient appears on `/ward`.
- **Concern:** if the OP visit is still `open`, the two-encounter transaction did not hold
- **Verify:**
  ```bash
  mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
    db.encounters.find({ patientId: "<PATIENT>" }, { class: 1, open: 1, status: 1 }).toArray()'
  ```
  **Expected:** the OP row `status: "admitted"` and **not** `open: true`; one IP row `open: true`.
- **Record:** the IP encounter id and the bed code

### JR-14 · 🔴 Occupied bed — **Doctor**

- **Action:** admit a **second** synthetic patient to the bed JR-13 just filled
- **Expected:** **`409 HMS-STATE-001`** — _"That bed is already occupied"_, **naming ward and bed**
- **Concern:** two patients in one bed is the classic hospital-system bug. **A `201` here is a P1.**
- **Verify:** the bed still holds exactly one patient
- **Note:** you will need a second synthetic patient with an open visit. Register and start one as
  the Receptionist first.

### JR-15 · Move bed — **Nurse A**

> 🔴 **IRREVERSIBLE.**
> 🔁 **Switch user — and note this is a different permission.**

- **Screen:** `/ward` → **"Move bed"** → pick a free bed under **"Move to"**
- **Expected:** `200`; the board shows the new bed and the old one is **free**. **The stay tariff does
  not change.**
- ⚠️ **A `403` here means the wrong login.** This is `bed:allocate` (NURSE), **not**
  `admission:create` (DOCTOR).

### JR-16 · Move onto a taken bed — **Nurse A**

- **Action:** move the patient onto the bed **another patient is in**
- **Expected:** **`409 HMS-STATE-001`** — the same refusal as JR-14
- **Concern:** the transfer path must be guarded by the **same rule** as admission, not only the
  admit path

### JR-17 · Vitals, notes, doses on the stay — **Nurse A**

- **Action:** record vitals, a nursing note, and give a due dose — **against the IP encounter**
- **Expected:** all succeed and attach to the **IP** encounter, **not** the closed OP one
- **Concern:** clinical writes landing on the closed outpatient visit would be **invisible on the
  ward**
- **Verify:**
  ```bash
  mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
    print("vitals on IP: " + db.vitals.countDocuments({ encounterId: "<IP ENCOUNTER>" }));
    print("notes  on IP: " + db.wardNotes.countDocuments({ encounterId: "<IP ENCOUNTER>" }));'
  ```
  **Both ≥ 1**, and **nothing** new on the OP encounter id.

### JR-18 · Discharge — **Doctor**

> 🔴 **IRREVERSIBLE — the stay closes.**
> 🔁 **Switch user.** `admission:discharge` is **DOCTOR-only** and deliberately not the nurse's.

- **Action:** discharge the patient **with a discharge summary**
- **Expected:** `201`. The stay closes; **the bed is free on `/ward`.**
- **Note the admission and discharge times** — JR-20 needs them.

### JR-19 · 🔴 A second summary — **Doctor**

- **Action:** attempt a **second** discharge summary on the same stay
- **Expected:** **refused — exactly one per admission**
- **Concern:** _"A stay ends with two summaries and nothing says which one was sent to the patient."_

### JR-20 · Bed-days — **Cashier**

> 🔁 **Switch user.**

- **Screen:** `/billing` → the stay's charges
- **Expected:** **one charge per calendar day started, minimum one** — admitted 22:00 and discharged
  09:00 is **two** days, **in the branch's timezone**
- **Concern:** this is **money**, and it was a real defect (see TZ-09)
- **Do the arithmetic yourself** from the times you noted in JR-13 and JR-18, in `Asia/Kolkata`, and
  compare with what the bill says. Write both numbers down.

### JR-21 · Finalize and pay — **Cashier**

> 🔴 **IRREVERSIBLE — finalizing and taking payment.**

- **Action:** finalize the bill; take a payment
- **Expected:** the invoice totals **the consultation, the drugs, the investigation and the
  bed-days**. Payment recorded; **a receipt is available.**
- **Concern:** **a finalized bill missing the drugs means JR-12's event never landed**
- **Check each of the four line groups is present before finalizing.** Once finalized you cannot
  re-open it.

### JR-22 · The record afterwards — **Doctor**

- **Action:** re-open the patient
- **Expected:** **one patient, one episode, both encounters, the whole story in order**
- **Concern:** if the journey reads as **two unrelated patients**, JR-02 or JR-06 failed and was not
  noticed
- 📸 screenshot of the complete timeline — this is the journey's closing evidence

---

### DUP-01 · Duplicate dispensing — **Pharmacist**

> ⚠️ **Read the box below before judging this row.**

- **When:** during JR-12
- **Action:** on the handover, **double-click** the dispense button. Then repeat with the browser's
  DevTools network throttled to **3G** (see §24 for how).
- **Expected:** **one** `dispenses` row · **`200` with `duplicate: true`, NOT a `409`** — the second
  attempt answers with the **first** handover · `dispensedQty` rises **once** · stock decrements
  **once**
- **Verify by counting, not by reading the status code:**
  ```bash
  mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
    db.dispenses.countDocuments({ prescriptionId: "<RX>" })'
  ```

### DUP-02 · Duplicate order — **Doctor**

- **When:** during JR-09
- **Action:** **double-click** the order button
- **Expected:** **one** `orders` row, **one** work item on the lab queue. Again **`200` +
  `duplicate: true`**, and the screen says **"already ordered"** rather than reporting a second test.

### 🔴 Why DUP-01 and DUP-02 expect `200` and not `409`

> The MAR answers a repeated dose with `409 HMS-MAR-001`, because charting the same slot twice is a
> **clinical contradiction a human must see**.
>
> A repeated **dispense or order** is almost always a double-click or a retry. So the server returns
> the original row and says so — the drugs are handed over once and the patient is told once.
>
> **A `409` here would be a defect in the opposite direction**, and a tester expecting MAR's shape
> would report the correct behaviour as broken.
>
> **Verify by counting rows, not by reading the status code.**

### TEN-01 · Second-tenant isolation

Already covered in full at **§9**. If you have not run it yet, run it now. **Any leak is a P0 — stop
the campaign and report immediately.**

---

# PART D — WEB VALIDATION

## 20. WEB-01 … WEB-24

### Setup for the whole part

|                |                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| **URL**        | `http://sunrise.localhost:3000` — or `http://sunrise.<lan-ip>.sslip.io:3000` if §21 moved `TENANT_BASE_DOMAIN` |
| **Account**    | **Nurse A** (`nurse@sunrise.test` / `123456`) unless the row says otherwise                                    |
| **Branch**     | **Main Branch (A)** unless the row says otherwise                                                              |
| **Navigation** | **Ward** → `/ward` · **Medication round** → `/medication-round`                                                |

> **Why the round needs only `emr:read` and not `mar:administer`:** a doctor or pharmacist
> reconciling what a patient actually received is a legitimate **reader**. The boundary that matters
> is on the **write**, which stays `mar:administer`. A viewer sees the round with its dose actions
> **inert** — that is **WEB-19, and it is correct behaviour, not a permission leak.**

### Marked rows — plan for these

| Marking                          | Rows           | What you need                                                |
| -------------------------------- | -------------- | ------------------------------------------------------------ |
| 🖥️ **Browser DevTools**          | WEB-17, WEB-18 | Network tab → Offline (§24)                                  |
| 👥 **Two people / two sessions** | WEB-16         | Nurse A **and** Nurse B, two devices or two browser profiles |
| 🔀 **Branch switching**          | WEB-20         | Both branches configured                                     |
| 🚫 **Permission denial**         | WEB-19         | The **Doctor** login                                         |
| 🌍 **OS timezone change**        | WEB-21         | Changing your **computer's** clock (§23 — read the warning)  |
| ♿ **Accessibility**             | WEB-23         | Keyboard only, plus a screen reader (VoiceOver: `Cmd+F5`)    |
| 📐 **Layout**                    | WEB-22         | DevTools device emulation at 768px and 1024px                |

### The rows

Steps and Expected are the runbook's. The **How** column is the beginner detail.

| ID         | Role            | Steps                                                        | Expected                                                                                                                                                                      | How to do it                                                                                               |
| ---------- | --------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **WEB-01** | Nurse A         | Sign in at the tenant host                                   | Reaches the app; nav shows **Ward** and **Medication round**                                                                                                                  | Missing nav = permission mapping broken. Screenshot the nav.                                               |
| **WEB-02** | —               | Browse a slug that does not exist                            | _"This address does not belong to any hospital"_ — **the URL, not the password**, **on load**                                                                                 | **DECIDED — product changed to match this row.** See `TESTING.md` §11.                                     |
| **WEB-03** | Nurse A         | Open `/ward`                                                 | Admitted patients for **branch A**, with beds                                                                                                                                 | Expect ~42 rows                                                                                            |
| **WEB-04** | Nurse A         | Read rows                                                    | Name on every ward row; **name + UHID together on the administering surfaces** (§9)                                                                                           | **AMENDED** — a ward list is not an administering surface. See `TESTING.md` §11.                           |
| **WEB-05** | Nurse A         | Find bed **GW-1** on `/ward` **and** `/medication-round`     | Name and UHID present, resolved server-side                                                                                                                                   | 🔴 **`Patient: —` = FAIL, safety.** The exact regression `375e4cf` fixed, **never yet seen in a browser**. |
| **WEB-06** | Nurse A         | Open `/medication-round`                                     | _"Every dose expected on the ward today, earliest outstanding first."_ Rows carry name, UHID, bed                                                                             |                                                                                                            |
| **WEB-07** | Nurse A         | Select a dose                                                | Name · UHID · bed · drug · **dose · route** · scheduled time                                                                                                                  | **Missing field = stop and report.** → §9 five rights                                                      |
| **WEB-08** | Nurse A         | 42 patients at page size 20                                  | The footer **states there are more pages**                                                                                                                                    | 🔴 _"A nurse reading '2 doses due' off page one of three and stopping"_ is the failure this guards         |
| **WEB-09** | Nurse A         | Open a patient whose doses are all answered                  | Shows the given/held/refused doses — **not** "All doses answered" _instead of_ them                                                                                           | Hiding answered doses hides the record. This was a real defect.                                            |
| **WEB-10** | Nurse A         | Open a quiet patient                                         | An explicit empty state, **never a blank row**                                                                                                                                | Use one of the 30 quiet patients                                                                           |
| **WEB-11** | Nurse A         | On a TDS patient select **14:00**                            | The confirmation **names the dose you selected**                                                                                                                              | Charting the wrong slot is the risk                                                                        |
| **WEB-12** | Nurse A         | Confirm a dose                                               | **Server-authoritative "Given"**                                                                                                                                              | 🔴 Irreversible. A local flip the server never saw is the failure.                                         |
| **WEB-13** | Nurse A         | Hold **with no reason**                                      | Refused until a reason is given                                                                                                                                               | A blank in the MAR is a question nobody can answer later                                                   |
| **WEB-14** | Nurse A         | Refuse a dose                                                | Records **without** a reason; reason still offered                                                                                                                            | Forcing a reason on a refusal invents data                                                                 |
| **WEB-15** | Nurse A         | Re-attempt the same dose                                     | **`409 HMS-MAR-001`** read as an **answer**: "already given", **by whom, when, no retry**                                                                                     | _"Not saved — try again"_ here would be old behaviour returning                                            |
| **WEB-16** | Nurse A **+ B** | → **MAR-02**, using web as one of the two sessions           | **Exactly one succeeds**                                                                                                                                                      | 👥 See §22.1                                                                                               |
| **WEB-17** | Nurse A         | DevTools → Offline during **Give**. → **LR-01**              | Reconciles; **exactly one row**                                                                                                                                               | 🖥️ See §23                                                                                                 |
| **WEB-18** | Nurse A         | Record vitals, → **LR-04**, then **LR-05**                   | **One** observation; a later genuine reading still accepted                                                                                                                   | 🖥️ See §23                                                                                                 |
| **WEB-19** | **Doctor**      | Open `/medication-round`                                     | The round **renders**; dose actions are **inert**                                                                                                                             | ✅ **Correct. Not a leak.** 🔴 If a doctor can actually chart, that is a **P1**.                           |
| **WEB-20** | Nurse A         | Switch A → B → A **on the round**                            | Subtree discarded and reloaded each time; **no stale rows**; header and data **always agree**                                                                                 | 🔀 → BR-08                                                                                                 |
| **WEB-21** | Nurse A         | → TZ-01 / TZ-04 in the browser; change the **OS** timezone   | Times stay in the **branch's** zone                                                                                                                                           | 🌍 §23 — read the warning first                                                                            |
| **WEB-22** | Nurse A         | 768px and 1024px widths                                      | Round and confirmation usable; **identity line never clipped**                                                                                                                | 📐 DevTools → toggle device toolbar                                                                        |
| **WEB-23** | Nurse A         | Keyboard-only through the round; screen reader on a dose row | Every action reachable by keyboard **with a visible focus state**; the row announces patient → drug → dose → route → time → state. **Colour alone must not carry "overdue".** | ♿ Tab/Shift-Tab only. Never touch the mouse.                                                              |
| **WEB-24** | Nurse A         | Revoke the session server-side; act                          | **Explicit re-authentication**, not a silent failure                                                                                                                          | Sign out in another browser tab, then act in the first                                                     |

### How to do the three that need explaining

**WEB-19 — checking the actions are inert.** Sign in as the **Doctor**, open `/medication-round`. The
page must load and show the doses. Then try to press a dose action. It must not do anything. **Then
confirm at the API** that it is not just the button being hidden:

```bash
DOC=$(curl -s "$BASE/api/v1/auth/login" -X POST -H 'Content-Type: application/json' \
  -d '{"email":"drrao@sunrise.test","password":"123456"}' | jq -r '.data.accessToken')

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "$BASE/api/v1/encounters/<ENC>/medication-administrations" \
  -H "Authorization: Bearer $DOC" -H "X-Active-Branch: $BRANCH_A" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"prescriptionId":"<RX>","lineIndex":0,"scheduledFor":"<ISO>","status":"given"}'
```

**Expected: `403`.** _A hidden button is not evidence; a `403` is._

**WEB-23 — keyboard only.** Put the mouse away. `Tab` moves forward, `Shift+Tab` back, `Enter` or
`Space` activates. At every stop you must be able to **see** where you are. If focus disappears, that
is the defect.

**WEB-22 — narrow widths.** DevTools (`F12` / `Cmd+Opt+I`) → the device-toolbar icon → set the width
to 768, then 1024. Check the **identity line** specifically: name and UHID must both stay visible.

---

# PART E — MOBILE VALIDATION

## 21. Getting the phone connected — do this once for the whole campaign

### The problem, and why it needs a strange-looking domain

A phone cannot use `localhost` — that would mean the phone itself. And using your computer's IP
address alone does not work either, **because the server reads which hospital you are from the
subdomain**. `192.168.1.7` has no subdomain.

The app solves it with `sslip.io`, a public DNS service that turns any IP into a hostname. So
`sunrise.192.168.1.7.sslip.io` resolves to `192.168.1.7` **and** carries the hospital name.

### Step by step

**1. Start Metro and read the line it prints:**

```bash
pnpm --filter @medicore/mobile start
```

It prints exactly what to use:

```
📱 mobile will call  http://<hospital>.192.168.1.7.sslip.io:4000
   the API needs     TENANT_BASE_DOMAIN=192.168.1.7.sslip.io  (apps/api/.env)
```

**2. Set that value** in `apps/api/.env` and restart the API.

**3. 🔴 Confirm the hostname resolves a hospital BEFORE you pick up the phone.** From a handset, a
tenant-resolution failure and a wifi failure look identical:

```bash
curl -s -H 'Host: sunrise.192.168.1.7.sslip.io' http://192.168.1.7:4000/api/v1/auth/login \
  -X POST -H 'Content-Type: application/json' -d '{}'
# HMS-VAL-001 → tenant resolved, only credentials missing. Good.
# HMS-TEN-001 → host did not match a tenant. The two domains disagree.
```

**You want `HMS-VAL-001`.** If you get `HMS-TEN-001`, the domain in `.env` and the one Metro printed
do not match.

### ⚠️ Sequencing — this catches people out

`TENANT_BASE_DOMAIN` also drives the browser's CORS allowlist. So **while it is set to sslip, the web
app must be browsed at `sunrise.192.168.1.7.sslip.io:3000`, not `sunrise.localhost:3000`.**

> **Set it once at the start of the campaign and use sslip URLs on every surface.** Each switch needs
> an API restart and `pnpm start -c`, and **a half-switched environment produces failures that look
> exactly like product defects.**

> `app.config.ts` is read **when Metro starts.** Changing networks or editing it does nothing until
> you restart with `pnpm start -c`. A stale domain in the app's hospital-screen hint is the quickest
> tell.

### ENV-07 · Expo Go or a development build?

**Verify this; do not assume it.** Inspection says the app should run in **Expo Go** (managed
workflow, no `expo-dev-client`, all-Expo native dependencies, SDK 54) — **but no device has ever
confirmed it.**

| ID         | Steps                                                                               | Expected                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **ENV-07** | `pnpm --filter @medicore/mobile start`, scan the QR code with **Expo Go**, sign in. | The app loads and reaches a signed-in screen. **Then** open Settings and enable the screen lock: **the OS prompt must appear.** |

**If either half fails:** record **ENVIRONMENT ISSUE**, build a development build, note it in your
results, and **correct the two device checklists** — both currently state "Expo Go is sufficient".

> Known caveat: `expo-secure-store` inside Expo Go shares storage with other Expo Go projects.
> Harmless for validation; it is not how a real build behaves.

### Which device for what

| Surface                   | Needed for             | Real hardware required?                                                                    |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| **Android phone**         | All of M3; M2-35…M2-47 | **Yes** — a simulator has no enrolled fingerprint, no real radio, no app-switcher snapshot |
| **Second phone**          | **MAR-02**, M3-35      | **Yes** — two identities must be two sessions                                              |
| **iPhone with Face ID**   | M2-35…M2-47 on iOS     | **Yes** — the lock's failure modes differ per platform                                     |
| **Small phone (SE / 5")** | M2-24                  | **Yes**                                                                                    |
| Desktop browser           | All of Part D          | No                                                                                         |
| Tablet / narrow browser   | WEB-22                 | No — DevTools emulation is fine                                                            |

**Simulators are acceptable** for layout, navigation and network-off scenarios. **They are not
acceptable** for biometrics, cellular handover, app-switcher snapshots, or anything in §22.

**Record for every device:** model · OS version · app build/commit · Expo Go or dev build.

---

## 22. The mobile rows

> **The runbook's tables are the authority for Steps and Expected** (§6 for M2, §7 for M3). This
> section tells you how to run them and which ones are traps. **Do not re-type expected results from
> memory — read them from the runbook as you go.**

### 22.1 M2 — Doctor mobile (M2-01 … M2-52)

Sign in as **`drrao@sunrise.test` / `123456`**, hospital code `sunrise`.

| Block                             | Rows        | Beginner notes                                                                                                                                                                           |
| --------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Authentication and session** | M2-01…M2-09 | **M2-01 is the foundation gate.** An empty tab bar after login is a permission→navigation break, not a cosmetic issue. **M2-03 is N/A if no MFA account exists — say so, do not guess.** |
| **B. Branch**                     | M2-10…M2-15 | **M2-15 is a P1 row:** deep-link to a branch-A patient while in branch B. _"It must never render."_                                                                                      |
| **C. Clinical reads**             | M2-16…M2-24 | **M2-18 and M2-22 need you to change the device's timezone** — see §25. **M2-20 is a P1:** an unverified result must show "Awaiting verification" and **no values**.                     |
| **D. Clinical writes**            | M2-25…M2-34 | **M2-27 and M2-30/32 need airplane mode.** _"A false 'Saved' is a P1."_ **M2-30 is irreversible — a double-signed prescription is a P1.**                                                |
| **E. Screen lock**                | M2-35…M2-47 | 🔴 **The largest unverified block in M2 — none of these has ever run on hardware.** Needs an enrolled fingerprint or Face ID.                                                            |
| **F. Accessibility**              | M2-48…M2-51 | Largest OS text size, VoiceOver/TalkBack, thumb reach, sunlight                                                                                                                          |
| **G. Not-yet-built**              | M2-52       | Any unbuilt area must **say so** and be reachable **without crashing**                                                                                                                   |

**M2-35 … M2-47 — how to run the screen-lock block.** These need a device with a biometric
**enrolled** in the OS settings first.

- **M2-36 / M2-37** — background the app for **under** 15 minutes, then for **over** 15 minutes.
  🔴 **M2-37's gate must be the FIRST frame** — the chart must not be visible for even a moment when
  you resume. Watch carefully; if you blink you will miss the defect.
- **M2-38** — the OS prompt must appear **by itself**, without you tapping anything.
- **M2-40 vs M2-41** — a **failed** scan decrements the attempt counter; a **cancelled** prompt must
  **not**. This pair is the easiest to get wrong: cancel deliberately, and check the counter did not
  move.
- **M2-45** — remove the enrolled biometric in OS settings **while the app is backgrounded**, then
  resume. 🔴 **It must not silently unlock.**
- **M2-46** — open the app switcher. It must show a **privacy cover**, not a patient.

### 22.2 M3 — Nurse mobile (M3-01 … M3-37)

Sign in as **Nurse A** (`nurse@sunrise.test`). **M2-01…M2-12 are a prerequisite** — run them first.

| Block                          | Rows        | Beginner notes                                                                                                                                                                                                                           |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Login and session**       | M3-01…M3-03 | M3-03 swaps to **Nurse B** — _no cached rows from Nurse A may survive_                                                                                                                                                                   |
| **B. Ward worklist**           | M3-04…M3-07 | M3-04: bed order must be **numeric** — `GW-2` before `GW-10`. **M3-07: the list must never blank while refreshing.**                                                                                                                     |
| **C. Identity**                | M3-08…M3-09 | **Name and UHID on all three surfaces** — worklist row, chart header, dose confirmation                                                                                                                                                  |
| **D. Allergies**               | M3-10…M3-11 | 🔴 **M3-10 is the highest-severity display row in the document.** M3-11: it must say _"None recorded… That is not the same as no allergies"_ — **never "no allergies"**.                                                                 |
| **E. Vitals**                  | M3-12…M3-16 | M3-13: an implausible value is refused **and your typed value stays on screen**. M3-14: **two readings are both kept** — vitals are deliberately not unique.                                                                             |
| **F. Nursing notes**           | M3-17…M3-20 | **M3-19: double-tap save → exactly one note**                                                                                                                                                                                            |
| **G. Medication round**        | M3-21…M3-27 | 🔴 **M3-22 is the five rights:** name · UHID · bed · drug · dose · route · scheduled time. **Stop and report if any is missing.** M3-25: the footer must admit there are more pages.                                                     |
| **H–K. Give / Hold / Refused** | M3-28…M3-33 | **M3-28: the patient is named FIRST.** _"Drug-first invites the wrong-patient error."_ **M3-32: an already-given dose has NO Give button at all.** M3-33 (`not_available`) is a **PRODUCT DECISION**, not a defect — record and move on. |
| **Q–T. Branch, staleness**     | M3-34…M3-37 | See below                                                                                                                                                                                                                                |

**M3-35 — the near-miss row, and it needs two people.** Nurse A opens the round; **Nurse B gives a
dose** on the other device; Nurse A taps that dose. **Expected:** it re-reads and shows **already
answered**. **Nurse A must never see an active Give button.**

**M3-37 — do not report this one as a defect.** Leave the round untouched in the foreground for five
minutes. It **may legitimately show the older state** — the round is _advisory_, the confirmation
screen is _authoritative_. What you must confirm is that **a stale tap still lands on "already
answered"**.

### 22.3 The five rights (FR-01 … FR-03)

**This is not a UI review.** Each of the five is a field a nurse legally relies on before putting a
drug into a person.

> 🔴 **A blank patient name, a missing UHID, or an ambiguous dose is a SAFETY CONCERN, not a cosmetic
> defect.** If any of the five is missing or ambiguous on a real screen, **stop that scenario and
> report it** — do not finish the round and mention it later.

| #   | Right                | Expected on the confirmation screen                                               |
| --- | -------------------- | --------------------------------------------------------------------------------- |
| 1   | **Right patient**    | Full name **and** UHID, named **first**, not truncated to uselessness             |
| 2   | **Right medication** | e.g. `Paracetamol 500mg Tablet` — the name from the **signed line**, not a code   |
| 3   | **Right dose**       | e.g. `500 mg`                                                                     |
| 4   | **Right route**      | `oral` for every seeded line                                                      |
| 5   | **Right time**       | The scheduled time **in the branch's zone**, e.g. `14:00` for the TDS middle dose |

**FR-01** — run once on **mobile** and once on **web**. **Evidence:** a photograph of the
confirmation screen, **plus** the same five read back from
`GET /encounters/:id/medication-schedule`, so screen and server can be compared field for field.

**FR-02 — the long-stay patient (web defect D-1).** Web **first** — that is where it broke. Open the
medication round, find bed **GW-1**, read the row, then select a dose and read the confirmation.
**Name and UHID must be present on both.** 🔴 **`—`, `Patient: —`, a blank, or an id where a name
belongs = FAIL, safety. Stop and report.** _Fixed in `375e4cf`; the fix has never been seen in a
browser. That is exactly why this row exists._

**FR-03** — find or create a synthetic patient with a very long name; open the confirmation at the
largest OS text size. The name may wrap or truncate, **but the UHID must still be visible**.

### 22.4 Licence / edition (LIC-01 … LIC-06)

**"PREPARED" means the state can be produced on demand — not that anybody has looked at the screen.
Every row is unexecuted.**

**Provision the licence hospital ONCE. Never point this at the validation tenant** — every other
section depends on it still working, and the script refuses any slug that does not contain `licence`
for exactly that reason.

```bash
pnpm seed:hospital -- --name "Licence Lab" --slug licence-lab --plan PLAN_ENTERPRISE
pnpm seed:migrate  -- --slug licence-lab
```

Then move it between states. **Each command prints the state the SERVER computed**, so the line it
prints is the state you are actually testing:

| Row        | Command                                                    | Prints               | Expected on screen                                                                                                             |
| ---------- | ---------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **LIC-01** | `pnpm seed:licence -- --slug licence-lab --state active`   | `ACTIVE`, ~3650 days | **No banner anywhere**                                                                                                         |
| **LIC-02** | `pnpm seed:licence -- --slug licence-lab --state expiring` | `ACTIVE`, 5 days     | **Amber strip** above the tab bar with a day count. **Check the layout** — never seen on a device.                             |
| **LIC-03** | `pnpm seed:licence -- --slug licence-lab --state grace`    | `GRACE`, 6 days      | **Red strip — and every clinical write still works**                                                                           |
| **LIC-04** | `pnpm seed:licence -- --slug licence-lab --state expired`  | `EXPIRED`, 0 days    | "Subscription expired" as a **blocking** state; save controls disabled **with that reason**, rather than failing after the tap |
| **LIC-05** | `--state expired`, then `--state active` mid-session       | `EXPIRED` → `ACTIVE` | Pull to refresh clears the block **without a restart**                                                                         |
| any        | `pnpm seed:licence -- --slug <slug> --show`                | read-only            | Safe on any hospital                                                                                                           |

🔴 **LIC-03 is the one that is easy to get wrong.** In GRACE **every clinical write must STILL
work.** A red strip **and** a working MAR is the PASS. **If writes are blocked in grace, that is a
defect** — a hospital the server is still serving must still be able to record what was done to a
patient.

**LIC-02 sits at half the warning window (5 of 10 days) deliberately** — a licence expiring on
exactly the boundary would produce an ambiguous result.

**LIC-06 remains BLOCKED.** It needs an edition that **excludes the nursing module**, which is a plan
question rather than a licence one. Record it as BLOCKED with that reason.

---

# PART F — CONCURRENCY / NETWORK / REAL-WORLD TESTS

## 23. Concurrency — MAR-01 … MAR-05

### 23.1 MAR-02 — two nurses, two devices, one dose

**This is the most important test in the entire campaign**, and it cannot be simulated honestly.

> 👥 **You need two people, or at least two devices with two different logins.**
> **One account signed in twice is one identity, which is exactly what this test must not have.**
> If you cannot do that today, mark it **BLOCKED**. Do not fake it.

**Before you start, understand the two mechanisms** — getting this wrong sends a bug report to the
wrong place:

|                     | **Database uniqueness**                                | **Idempotency-Key**                                                                         |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Question it answers | _"Has **anyone** already charted this dose slot?"_     | _"Have **I** already sent **this exact request**?"_                                         |
| Fires as            | `409 HMS-MAR-001`, carrying `details.existing`         | `409 HMS-REQ-002` (same key, different body) · `409 HMS-REQ-004` (same key still in flight) |
| Protects against    | **Two different people**, or one person on two devices | **One client retrying** after a lost response                                               |

> 🔴 **A PRN (`SOS`) dose given twice is NOT a defect.** PRN is deliberately unconstrained, because a
> second as-required dose is legitimate. **Use a SCHEDULED dose.** Testing on the SOS line will show
> both succeeding, and that is correct.

**Setup**

1. `pnpm seed:validation -- --verify` says READY.
2. **Nurse A** signed in on device 1. **Nurse B** (`nurse2@sunrise.test`) on device 2. _(Web counts
   as one of the two.)_
3. Find a **scheduled** dose that is **due and unanswered**.
4. **Write down the patient, bed, drug and scheduled time before starting.**

**Execution**

1. Both people open the **same** dose confirmation screen.
2. **Confirm both screens show the same patient, drug, dose and scheduled time.** If they differ, you
   are not testing the same dose.
3. **On a count of three, both press Give.**

**Expected**

> **Exactly one succeeds.** The other receives **`409 HMS-MAR-001`** and is told the dose is already
> given, **by whom and when, with no retry offered.** Neither nurse sees a generic error.

**Then verify the server, not the screen — MAR-03:**

```bash
mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
  db.medicationAdministrations.find(
    { prescriptionId: "<PRESCRIPTION_ID>", lineIndex: <N>, scheduledFor: "<ISO>" },
    { administeredBy: 1, status: 1, administeredAt: 1, branchId: 1 }
  ).toArray()'
```

**Expected: exactly one document.**

And confirm the constraint is actually armed:

```bash
mongosh "mongodb://localhost:37018/hms_sunrise" --quiet --eval '
  db.medicationAdministrations.getIndexes().filter(i => i.unique)'
```

**Expected:** a unique index on `{tenantId, prescriptionId, lineIndex, scheduledFor}` with
`partialFilterExpression: { scheduledFor: { $exists: true } }`.

> 🔴 **If that index is absent, every result in this section is void.** Re-run §2.5 and §2.6 and
> start again **before writing a defect report.** This is not hypothetical — it happened on
> 2026-08-14, and it produced seven false P0 reports.

**PASS / FAIL**

- **PASS** — exactly one success, the other gets `409 HMS-MAR-001` naming who and when with **no
  retry offered**, and Mongo has **exactly one** document.
- **FAIL** — 🔴 **Two successes is a P0. Stop immediately**, capture everything, and **check the
  index (above) before concluding.** Also a FAIL: a generic error message, or a **retry button** on
  the refusal — a retry here invites the exact action the constraint exists to prevent (P1).
- **BLOCKED** — only one device or one identity available.

**Evidence:** 📸 **both** screens photographed · both network responses · the Mongo document count ·
**both nurses' identities** · timestamps for both.

### 23.2 The rest of the MAR rows

| ID         | What                                       | Beginner note                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MAR-01** | Duplicate — **same** nurse, second attempt | Reopen a dose you already gave. **If the UI offers no way to give it again, that is M3-32 passing** — record it, and use the API to confirm the server's answer. Expected `409 HMS-MAR-001`, UI says "already given", names **who and when**, **offers no retry**. A generic error is a FAIL. |
| **MAR-03** | Verify the server, not the screen          | The query above. **The UI's claim is not the evidence.**                                                                                                                                                                                                                                      |
| **MAR-04** | **PRN is deliberately different**          | Give the **SOS** line, then give it **again**. **Both must succeed.** 🔴 If the second is refused, the constraint is now _causing_ harm by blocking real care — **P1, worse than the defect it fixes.**                                                                                       |
| **MAR-05** | Line identity is a **position**            | On the 3-line prescription: give **line 1** (Amlodipine), then open **line 0** (Metformin) at its own time. **Line 0 must still be givable.** If giving one line marks another answered, dose identity is keyed on the drug rather than the position — **a P0-class defect.**                 |

---

## 24. Lost Response / Network Interruption — LR-01 … LR-06

### The idea

**The dangerous case is not "the request failed".** It is: **the server saved it successfully and the
client never heard back.** The client then knows only that it does not know. Everything here tests
what it does with that.

### How to induce it — use the project's documented methods, do not invent one

| Method                       | How                                                          | Good for                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **Airplane mode mid-flight** | Tap the action, then toggle airplane mode within **~200 ms** | Mobile. Most realistic. Hardest to time.                                                                                   |
| **Kill the API**             | `Ctrl-C` the API terminal the instant the request leaves     | Both. Easiest to time — **but it can also kill the commit if you are too fast.** Check the database to see which happened. |
| **Browser DevTools offline** | Network tab → **Offline**, toggled during the request        | Web. **Most repeatable — start here.**                                                                                     |
| **Walk out of wifi range**   | Genuinely walk                                               | The real cellular handover case. **Do this at least once** (M2-30 or LR-01).                                               |

**DevTools offline, step by step:** open DevTools (`F12` / `Cmd+Opt+I`) → **Network** tab → find the
throttling dropdown (usually says "No throttling") → select **Offline**. Press the button in the app,
then flip the dropdown to Offline. Flip it back to restore.

> 🔴 **Whichever method you use, you MUST afterwards determine what the server actually did.** The
> test is meaningless until you know whether the write landed. Use the MAR-03 query.

### The rows

| ID        | What                                          | Expected                                                                                                                                                                                         | Beginner note                                                                                                                                                                                                  |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LR-01** | Lost **MAR** response                         | **Step 3:** the app says it **could not confirm** — never "not saved", never "saved". **Step 5:** resolves to _"already recorded, nothing was recorded twice"_. **Step 6: exactly one MAR row.** | 🔴 _"Not saved" after a successful commit is a **P1** — it invites the nurse to give the drug again. **A second MAR row is a P0.**_ Note prescription id, `lineIndex` and `scheduledFor` **before** you start. |
| **LR-02** | Retry with the **held key** replays           | **The same record id** is returned. **No new row.**                                                                                                                                              | A new id means the key is not being honoured — reclassify as an **Idempotency-Key** failure, not a uniqueness failure                                                                                          |
| **LR-03** | Same key, **different body**                  | **`409 HMS-REQ-002`**                                                                                                                                                                            | API-level; `curl` is fine. Reuse a spent `Idempotency-Key` with a **different** dose. Accepting it means one key can write two different clinical facts.                                                       |
| **LR-04** | Lost **vitals** response (web defect D-2)     | Step 3: does **not** claim "Saved". Step 5: reconciles and reports what it found. **Step 6: exactly one observation** for that moment.                                                           | **Web first** — that is where it broke, and _the fix has never been confirmed in a browser_. Use a patient with **no vitals yet**.                                                                             |
| **LR-05** | Legitimate **repeat** observations still work | **Accepted, and both readings kept.**                                                                                                                                                            | 🔴 **The row that catches an over-correction.** Refusing a real second observation is a **P1 in the opposite direction** — a nurse who cannot record a deteriorating patient's second reading.                 |
| **LR-06** | **Backgrounded** mid-save                     | The mutation is **allowed to finish**                                                                                                                                                            | If the app cancels in flight _and_ discards the key, it has created the very ambiguity `Idempotency-Key` exists to resolve                                                                                     |

**Evidence for every LR row:** screenshot at step 3 **and** step 5 · **the network condition you
used** · the exact timing · the row count · **the `Idempotency-Key` sent — both attempts must carry
the same key.**

### The network matrix (NET-01 … NET-09)

| ID         | Scenario                           | How                             | Mandatory?                  | Expected                                                                                                                          |
| ---------- | ---------------------------------- | ------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **NET-01** | Normal wifi                        | —                               | **Mandatory**               | Baseline for everything else                                                                                                      |
| **NET-02** | Airplane mode, **read** screen     | Toggle                          | **Mandatory**               | Explained offline state with retry — **never a blank page**                                                                       |
| **NET-03** | Airplane mode, **write** screen    | Toggle                          | **Mandatory**               | Save disabled **with a reason**; nothing claims success                                                                           |
| **NET-04** | Server unreachable, **network up** | Stop the API, leave wifi on     | **Mandatory**               | _"Cannot reach the hospital's system"_ — **not** "no internet". **These are genuinely different and the app distinguishes them.** |
| **NET-05** | Request interrupted mid-flight     | → §24                           | **Mandatory**               | Reconciliation, **never a blind retry**                                                                                           |
| **NET-06** | Slow network                       | DevTools 3G / throttled hotspot | **Mandatory**               | Loading states appear **and resolve**; no screen sits blank                                                                       |
| **NET-07** | Reconnect                          | Restore after NET-02            | **Mandatory**               | Queries refetch on reconnect **without** a manual pull                                                                            |
| **NET-08** | Cellular handover                  | Walk out of wifi range mid-save | Optional but **do it once** | The only one that tests a genuine radio transition                                                                                |
| **NET-09** | Backgrounded during save           | → LR-06                         | Optional                    | The mutation completes                                                                                                            |

---

## 25. Device Clock / Timezone — TZ-01 … TZ-09

### ⚠️ Warning before you change any clock

> **Changing your device's clock or timezone affects every other application on it.** Calendars fire
> at the wrong time, certificates can appear expired, and other apps may behave oddly.
>
> **Write down the original setting before you change it, and restore it the moment the row is
> done.** On both phone and computer, the safest restore is to turn **"Set automatically"** back on
> and confirm the clock is correct before you continue.

### The rule under test

> **Clinical time is the BRANCH's, never the device's.**

Branch A is `Asia/Kolkata`; branch B is `America/New_York` — **9½–10½ hours apart**, chosen so the
two wards are on **different calendar days** during ordinary working hours.

### The rows

| ID        | Purpose                   | Steps                                                                                | Expected                                                                                                       | Needs a clock change?            |
| --------- | ------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **TZ-01** | Device zone is irrelevant | Set the **phone** to `Pacific/Kiritimati`. Open the round at branch A.               | Dose times read in the **ward's** clock (08:00/14:00/20:00 for TDS). **Unchanged.**                            | 🌍 **Yes**                       |
| **TZ-02** | Device midnight           | Near the **phone's** midnight but not the ward's                                     | The round still shows the **ward's** day. **It must not roll over or empty.**                                  | 🌍 **Yes**                       |
| **TZ-03** | Ward midnight             | Near the **ward's** midnight                                                         | The round rolls to the new clinical day                                                                        | ⏰ No — but plan the time of day |
| **TZ-04** | Two wards, two days       | With A and B on different calendar dates, open the round at each                     | Each shows **its own** day; TDS lands 08:00/14:00/20:00 **on each ward's own clock**                           | ⏰ No                            |
| **TZ-05** | Due / overdue             | Compare a dose's state against `--verify`'s overdue count and the branch clock       | State derives from the **branch** zone and `OVERDUE_AFTER_MS` (1 hour). **No client arithmetic.**              | No                               |
| **TZ-06** | Switch mid-day-boundary   | Switch A → B while the two are on different dates                                    | Header, day label and doses **all move together** to B's day                                                   | No                               |
| **TZ-07** | Timestamps carry the zone | Read any recorded time (vitals, note, administration)                                | Carries the branch's zone label; **does not move** when the device zone changes                                | 🌍 **Yes**                       |
| **TZ-08** | Reception register        | As Receptionist at **branch B**, near a date boundary, check the register's `?date=` | ✅ **Now a regression check** — the register's day is the **BRANCH's** day (fixed 2026-08-16)                  | ⏰ Plan the time                 |
| **TZ-09** | Bed-day billing           | Check bed-days on a stay at a differently-zoned site                                 | ✅ **Now a regression check** — bed-days count in the **branch's** zone (fixed 2026-08-16). **This is money.** | ⏰ Plan the time                 |

> ⚠️ **TZ-08 and TZ-09 changed meaning on 2026-08-16.** They used to say _"expect this to be wrong"_.
> **They now say "this must be right."** Read the Expected column, not your memory of the old runbook.

**Some rows are only meaningful near a midnight.** Plan around the clock rather than the checklist
order — TZ-02, TZ-03, TZ-08 and TZ-09 all want you to be there at the right moment.

---

## 26. Permissions and negative tests (PERM-01 … PERM-10, NEG-01 … NEG-14)

> **Run PERM-01…PERM-10 EARLY — before Part C and Part D.** Runbook §5.1 moves it to position 2 for
> a reason: _"~15 minutes of `curl`, and it tells you the role model you are about to trust is
> intact. Finding a permission hole **after** a day of role-based UI testing invalidates the day."_

> **Constitution §3.6: every route enforces authorization server-side. UI gating is convenience, not
> security.** So **every row here is verified at the API. A hidden button is not evidence; a `403`
> is.**

### The template

```bash
BASE=http://sunrise.localhost:4000        # or the sslip host from §21
TOKEN=$(curl -s "$BASE/api/v1/auth/login" -X POST -H 'Content-Type: application/json' \
  -d '{"email":"drrao@sunrise.test","password":"123456"}' | jq -r '.data.accessToken')

curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/v1/encounters/<ID>/medication-administrations" \
  -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'X-Active-Branch: <BRANCH_A_ID>' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"prescriptionId":"<RX>","lineIndex":0,"scheduledFor":"<ISO>","status":"given"}'
# expect 403
```

> ⚠️ **Node's `fetch` forbids setting a `Host` header.** If you script this in Node rather than
> `curl`, put the tenant **subdomain in the URL** — otherwise you get a `404` and think the route is
> missing.

**Expected refusal:** `403` with `HMS-AUTH-005`.
**Expected refusal for a resource outside your scope:** `404` with `HMS-GEN-404` — _deliberately a
404, because a 403 would confirm the record exists._

### The rows

| ID          | Test                                                        | Expected                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PERM-01** | Doctor attempts to administer a dose                        | `403 HMS-AUTH-005`                                                                                                                                                           |
| **PERM-02** | Receptionist attempts to administer a dose                  | `403 HMS-AUTH-005`                                                                                                                                                           |
| **PERM-03** | Receptionist attempts to read a medication schedule         | `403 HMS-AUTH-005`                                                                                                                                                           |
| **PERM-04** | Nurse writes a **nursing note**                             | `201`                                                                                                                                                                        |
| **PERM-05** | Nurse attempts the **doctor's clinical note** (`emr:write`) | `403 HMS-AUTH-005`. 🔴 **The nurse must have a working note route of her own (PERM-04) AND be refused this one. Either half alone is the wrong outcome.**                    |
| **PERM-06** | Nurse records vitals                                        | `201`                                                                                                                                                                        |
| **PERM-07** | Nurse attempts to close an encounter                        | `403` — closing freezes what can be billed and asserts the consultation happened                                                                                             |
| **PERM-08** | Every denial's **UI** shape                                 | An explanation — **not a dead button and not a raw error**                                                                                                                   |
| **PERM-09** | Doctor opens `/medication-round` on web                     | Renders; **actions inert** (→ WEB-19)                                                                                                                                        |
| **PERM-10** | **Permission held by nobody**                               | For each permission in the matrix, confirm **some seeded role holds it**. _A permission granted to no one is a feature nobody has — a recurring bug class in this codebase._ |

### Role × operation (the matrix you are verifying)

| Operation                  | Permission         | NURSE | DOCTOR | RECEPTIONIST |     TENANT_ADMIN     |
| -------------------------- | ------------------ | :---: | :----: | :----------: | :------------------: |
| Read medication schedule   | `emr:read`         |  ✅   |   ✅   |      ❌      |   _by role config_   |
| Read administrations       | `emr:read`         |  ✅   |   ✅   |      ❌      |   _by role config_   |
| **Administer a dose**      | `mar:administer`   |  ✅   |   ❌   |      ❌      |          ❌          |
| Medication round           | `emr:read`         |  ✅   |   ✅   |      ❌      |   _by role config_   |
| Record vitals              | `vitals:record`    |  ✅   |   ✅   |      ❌      |          ❌          |
| **Nursing note**           | `nursing:manage`   |  ✅   |   ❌   |      ❌      |          ❌          |
| **Doctor's clinical note** | `emr:write`        |  ❌   |   ✅   |      ❌      |          ❌          |
| Read patient               | `patient:read`     |  ✅   |   ✅   |      ✅      |          ✅          |
| Register patient           | `patient:register` |  ❌   |   ❌   |      ✅      |          ✅          |
| Close an encounter         | `encounter:close`  |  ❌   |   ✅   |      ❌      |   _by role config_   |
| Manage allergies           | `allergy:manage`   |  ✅   |   ✅   |      ❌      |          ❌          |
| Change plan                | `plan:manage`      |  ❌   |   ❌   |      ❌      | ❌ **operator only** |

_by role config_ — TENANT_ADMIN's clinical reach is a per-hospital configuration. **Verify against
the seeded role rather than assuming**, and mark **PRODUCT DECISION REQUIRED** if the repository does
not state the intent.

### Negative / falsification tests (NEG-01 … NEG-14)

**A runbook that only proves happy paths proves very little.** Each row attempts something that
should be refused and verifies the refusal. **None requires performing an unsafe clinical action** —
you attempt, and you observe the rejection.

| ID         | Attempt                                                                                | Expected                                                                                            | See also                                                    |
| ---------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **NEG-01** | Wrong role administers a dose                                                          | `403 HMS-AUTH-005`                                                                                  | PERM-01/02                                                  |
| **NEG-02** | Write to a **branch-B** encounter while scoped to A                                    | `404 HMS-GEN-404`                                                                                   | BR-04                                                       |
| **NEG-03** | **Duplicate scheduled dose**                                                           | `409 HMS-MAR-001` with `details.existing`; **exactly one row**                                      | MAR-01/02                                                   |
| **NEG-04** | Act on a **stale screen**                                                              | Re-read shows "already answered"; **no active Give**                                                | M3-35                                                       |
| **NEG-05** | **Lost response**, then retry                                                          | Reconciled; **one row**                                                                             | LR-01                                                       |
| **NEG-06** | Chart against the **wrong prescription line**                                          | Refused, or charted against the line actually selected — **never silently applied to another line** | MAR-05                                                      |
| **NEG-07** | Chart a dose slot **not on the schedule** (fabricated `scheduledFor`)                  | Refused                                                                                             | API-level                                                   |
| **NEG-08** | Chart against a **draft or cancelled** prescription                                    | Refused — the prescription must be in force                                                         | API-level                                                   |
| **NEG-09** | **Switch branch mid-workflow** — open a dose confirmation, switch branch, then confirm | The action does **not** complete against the old branch under the new branch's header               | 🔴 _"The most likely place for a real cross-branch write."_ |
| **NEG-10** | **Expired session** mid-write                                                          | Explicit re-authentication; the write does not silently vanish                                      | M2-09                                                       |
| **NEG-11** | **Network interruption** mid-write                                                     | → §24                                                                                               |                                                             |
| **NEG-12** | Reuse an `Idempotency-Key` with a **different body**                                   | `409 HMS-REQ-002`                                                                                   | LR-03                                                       |
| **NEG-13** | **Double-click** a submit                                                              | `409 HMS-REQ-004` (in flight) **or** one clean result — **never two records**                       |                                                             |
| **NEG-14** | Unknown `X-Active-Branch`                                                              | **Known defect D4** — widens the read to all sites                                                  | BR-09. **Record; do not re-report.**                        |

### The remaining branch rows (BR-01 … BR-09)

BR-10, BR-11, BR-07 and BR-12 are in Part A. These are the rest.

| ID        | What                                  | Expected                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BR-01** | A → B, clinical surfaces              | Ward becomes **Annexe Ward** with **3** patients; the round shows B's doses. **No row, name, bed or dose from branch A survives anywhere on screen.**                                                                                                                                                                                                                                                                               |
| **BR-02** | B → A, back again                     | Re-reads A's **42** patients. Not a cached frame; not a merge of both.                                                                                                                                                                                                                                                                                                                                                              |
| **BR-03** | Cross-branch **chart** is refused     | _"Not available here"_ / not-found. **It must not render.** Server returns `404 HMS-GEN-404`. 🔴 **Rendering is a P1.**                                                                                                                                                                                                                                                                                                             |
| **BR-04** | Cross-branch **writes** refused       | Both a nursing note and a dose against a branch-A encounter, while at B: **`404 HMS-GEN-404`**. _(Verified at the API already — re-confirm through the UI. This row is about whether the client can be talked into it.)_                                                                                                                                                                                                            |
| **BR-05** | Cross-branch **vitals**               | ✅ **Now a REGRESSION check — expect refusal, not rows.** `403`/`404`, **not** 200-with-rows. Schedule, administrations and notes still return **0 rows**; chart and patient still `404`. 🔴 **A 200 with rows is a P1 regression.** **Also check:** on the patient TREND view, a reading from the other site **must still appear** — that read is hospital-wide on purpose. Losing it is the fix over-applied, and its own defect. |
| **BR-06** | Branch **deactivated** underneath you | As tenant admin, deactivate the branch Nurse A is in; resume her app. It **falls back to a valid branch** and does not keep sending the dead one.                                                                                                                                                                                                                                                                                   |
| **BR-08** | **Stale UI** across a switch          | The round repaints. **Never A's doses under B's name in the header.**                                                                                                                                                                                                                                                                                                                                                               |
| **BR-09** | Unknown `X-Active-Branch`             | **KNOWN DEFECT — D4, P3.** All return `200` with `total=45` (all sites) instead of 42. It **cannot exceed the caller's binding**, so it is a correctness issue, not an escalation. **Record; do not re-report.**                                                                                                                                                                                                                    |

---

# PART G — HOW TO RECORD RESULTS

## 27. PASS / FAIL / BLOCKED — and the four others

**Use exactly these. Do not invent a ninth.** (Runbook §2.2.)

| Result                        | Means                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PASS**                      | **Observed with your own eyes**, on the stated surface, in this environment, at a recorded time.                                                 |
| **FAIL**                      | Observed behaviour **differs from Expected**.                                                                                                    |
| **BLOCKED**                   | **Could not run**: missing hardware, missing environment state, or an unmet prerequisite. **Say which.**                                         |
| **ENVIRONMENT ISSUE**         | The failure is in the **harness**, not the product — API down, wrong `TENANT_BASE_DOMAIN`, unconverged schema. **Not a defect**; fix and re-run. |
| **DATA ISSUE**                | The seeded data does not support the test (no overdue dose yet, ward already populated). **Not a defect.**                                       |
| **KNOWN DEFECT**              | Matches an entry in §29. **Record the evidence, cite the ID, move on. Do not re-report.**                                                        |
| **PRODUCT DECISION REQUIRED** | The behaviour is coherent but **the repository never states what it should be.** Escalate; do not guess.                                         |
| **N/A**                       | Genuinely inapplicable to this surface or edition.                                                                                               |

### 🔴 The three rules that decide whether this whole exercise was worth doing

1. **Never convert an automated PASS into a manual PASS.** If CI proves it, the manual row is a
   sanity check at best; **if you did not perform it, it is not done.**
2. **Never convert an untested scenario into PASS.** _"Looked fine"_ is not a result. **BLOCKED is a
   perfectly respectable answer and is more useful than a guess.**
3. **Never invent an Expected result.** If the repository does not define the behaviour, write
   **PRODUCT DECISION REQUIRED** and describe what you saw. _A tester's opinion silently becoming the
   spec is how a product acquires requirements nobody agreed to._

> **A test is NOT PASS because the automated suite is green.** The automated suite is green. That is
> why we are doing this. **A row is PASS only after a human executed it and saw the expected
> behaviour.**

---

## 28. Evidence Rules

### For every test (runbook §20.1)

```
TEST ID        e.g. MAR-02
DATE/TIME      with timezone — the branch's and the device's if they differ
DEVICE         model · OS version · Expo Go or dev build · commit
SURFACE        mobile / web / API
TENANT         sunrise
BRANCH         Main Branch (Asia/Kolkata) | Riverside Annexe (America/New_York)
ROLE           Nurse A / Nurse B / Doctor / Receptionist / Tenant admin / …
PRECONDITION   what was true before, including the --verify result
STEPS          what you actually did, not what the runbook said
EXPECTED       from the runbook
ACTUAL         what happened
RESULT         PASS / FAIL / BLOCKED / ENVIRONMENT ISSUE / DATA ISSUE / KNOWN DEFECT / PRODUCT DECISION REQUIRED
EVIDENCE       screenshot / video / network capture / query output
NOTES          anything that surprised you
```

### Additionally, for any safety failure (runbook §20.2)

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

### 🔴 What NOT to capture

- **No real patient data, ever.** Everything you touch is synthetic. If you ever find yourself
  looking at something that could be a real person, **stop and report it as a P0**.
- **Do not paste PHI into a ticket, a chat message, or a filename.** Use the patient's **id**, not
  their name, in written notes. A screenshot of a synthetic patient is fine; describing them by name
  in a shared channel is a habit that will one day be applied to a real one.
- **Do not paste tokens.** An access token is a live credential. Truncate it: `eyJhbGci…`.

### Two habits worth keeping

- **Capture the `--verify` output at the start and end of every session.** It is the cheapest
  possible proof that _the environment you tested is the environment you think you tested_.
- **Do not put test counts in your notes as facts.** Run the command and quote the run.

---

## 29. What To Do When Something Fails

### The procedure — follow it in order

1. **STOP.** Do not carry on to the next row on the same mechanism.
2. **Do not modify code.** Not to "check something", not to add a log line.
3. **Capture evidence** — §28, both blocks if it is a safety failure. **Capture before retrying.**
4. **Record the exact test ID.**
5. **Record the account, branch and tenant** you were using.
6. **Record the exact action** — what you clicked or what you sent.
7. **Record the Expected result** from the runbook.
8. **Record the Actual result**, in full.
9. **Check the prerequisite was actually met** — see the triage table below.
10. **Report it.**
11. **Do not mark it PASS.** Not later, not after it "worked the second time".

> 🔴 **For a P0/P1 safety failure:** stop the affected workflow immediately, capture the extended
> evidence set, **do not patch, do not retry to "see if it happens again" before recording the first
> occurrence**, and do not continue tests that depend on the same mechanism. **Report before
> proceeding.**

### Triage — is it really a product defect?

Work down this list. Most first-day "defects" are one of the first four.

| Ask                                                                                                                                   | If yes             | What to record                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **1. Is the environment sound?** Re-run `pnpm seed:validation -- --verify`. Does it say READY?                                        | If **not** READY → | **ENVIRONMENT ISSUE**. 🔴 _On 2026-08-14 this single question was the difference between seven P0 reports and zero._           |
| **2. Did I use the right account?** Check §4. Did you get `403 HMS-AUTH-005`?                                                         | →                  | **Not a defect.** Wrong role. Re-run with the right one. This is DRIFT-03/04/05's classic trap.                                |
| **3. Was I on the right branch?** Does the top bar say what the row required?                                                         | →                  | **Not a defect.** Re-run at the right branch.                                                                                  |
| **4. Was the prerequisite met?** e.g. a _due, unanswered, **scheduled**_ dose — not a PRN one; a _signed_ prescription; a _free_ bed. | →                  | **DATA ISSUE**, or fix the prerequisite and re-run.                                                                            |
| **5. Is it in the known-items list?** (below)                                                                                         | →                  | **KNOWN DEFECT.** Cite the ID and move on. **Do not re-report.**                                                               |
| **6. Did clinical data change, duplicate, or get lost?**                                                                              | →                  | **P0/P1.** Stop the workflow, capture extended evidence, report before continuing.                                             |
| **7. Is it cross-branch or cross-tenant data?**                                                                                       | →                  | **P1 candidate** (cross-tenant is **P0**). Capture **what was visible, to whom, and whether writes were possible.**            |
| **8. Does the repository define what should happen?**                                                                                 | If **not** →       | **PRODUCT DECISION REQUIRED.** Describe what you saw and what you expected **and why**. **Do not invent the expected result.** |
| **9. Otherwise**                                                                                                                      | →                  | **FAIL**, with severity by clinical impact.                                                                                    |

### Known items — record, cite, do not fix, do not re-report

> ⚠️ **Read the Action column before running BR-05, BR-09, TZ-08 or TZ-09 — the expected result has
> INVERTED.** These rows used to say _"expect this to be wrong"_. They now say _"this must be
> right."_

| Ref                 | Item                                                                                      | Sev | Shows up in                     | What you do                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- | --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ~~D1~~              | Cross-branch **vitals** PHI read                                                          | P2  | **BR-05**                       | ✅ **FIXED 2026-08-16.** Now a **regression check** — the foreign visit must `404` and the patient trend must still cross sites. |
| ~~D9~~              | Appointment state machine ignored branch scope — cross-branch **WRITE**                   | P1  | **BR-11**                       | ✅ **FIXED 2026-08-17.** Regression check. **Its second half — re-reading the state as an A user — is what actually proves it.** |
| ~~D10~~             | Report **file** download ignored branch scope                                             | P2  | **BR-10**                       | ✅ **FIXED 2026-08-17.** 🔴 **Must be probed directly, not clicked toward.**                                                     |
| **D11**             | An un-stamped legacy report is absent from the branch-scoped list                         | P3  | **BR-10** (also check)          | 🟡 **OPEN, pre-existing.** Loses no data; the download agrees with the list. **Record, do not re-report.**                       |
| ~~D2 / GAP-1~~      | Reception register `?date=` in the wrong timezone                                         | P2  | **TZ-08**                       | ✅ **FIXED 2026-08-16.** Now a regression check: **the register's day is the BRANCH's day.**                                     |
| ~~D3 / GAP-2~~      | Bed-day billing counted days in the wrong timezone                                        | P2  | **TZ-09**                       | ✅ **FIXED 2026-08-16.** Regression check. **Money — still worth eyes on.**                                                      |
| **D4**              | Unknown `X-Active-Branch` silently ignored                                                | —   | **BR-09**                       | 🔵 **NOT A DEFECT.** Fail-safe-to-own-scope, chosen deliberately. BR-09 confirms the **design**.                                 |
| **D5**              | `limits.maxBranches` not reconciled with the plan                                         | —   | §2.5                            | 🔵 **BY DESIGN.** What is open is narrower and is a **PRODUCT DECISION**.                                                        |
| ~~D6~~              | Migration 0048 over pre-existing duplicate claims                                         | P3  | §2.5                            | ✅ **FIXED 2026-08-16.**                                                                                                         |
| **D7**              | `administeredBy` renders an identifier, not a name                                        | P3  | MAR-01/02 evidence, five rights | 🟡 **OPEN, deliberately.** The record is complete and audited; **only the display is degraded.** **Product decision.**           |
| **T2**              | Fleet-wide migration convergence has no metric                                            | 12  | §2.5/§2.6                       | 🟡 **PARTIAL.** `--check` answers convergence for the fleet, but **T2 stays open**.                                              |
| **`not_available`** | A real MAR status the backend accepts and both clients **display** but neither **offers** | —   | **M3-33**                       | **PRODUCT DECISION REQUIRED** — should a nurse be able to select it?                                                             |

### ⚠️ Two different `D` numbering schemes — read before citing one

| Scheme              | Form         | Means                                               |
| ------------------- | ------------ | --------------------------------------------------- |
| **Risk register**   | `D1`…`D7`    | **Open, unfixed** defects                           |
| **Web fix history** | `D-1`, `D-2` | **Fixed** web defects, never confirmed in a browser |

🔴 **`D1` and `D-1` are unrelated and point in opposite directions** — one is a cross-branch PHI
exposure, the other is a fixed identity bug. **Always write "risk-register D1" or "web defect D-1".**

### Raise, never work around

**Never work around and continue:**

- a missing safety constraint
- a duplicated or lost clinical record
- cross-branch or cross-tenant data
- a false success message
- a five-rights field that is blank
- **anything that made you say "that can't be right" and then carry on**

---

# PART H — MASTER CHECKLIST

## 30. Manual Validation Progress Tracker

**232 manual test IDs. Every one is `NOT RUN`.** Nothing in this table may be pre-marked, and nothing
may be marked PASS from automated evidence.

**Allowed status values:** `NOT RUN` · `IN PROGRESS` · `PASS` · `FAIL` · `BLOCKED`
_(plus the four qualifiers in §27 where they apply: ENVIRONMENT ISSUE · DATA ISSUE · KNOWN DEFECT ·
PRODUCT DECISION REQUIRED.)_

**Priority = execution phase**, taken from the runbook's §5.0 and §5.1 ordering. **It is not defect
severity** — severity is decided per finding, in §29.

| ID           | Area                         | Priority            | Status  | Date | Tester | Evidence | Notes                                                         |
| ------------ | ---------------------------- | ------------------- | ------- | ---- | ------ | -------- | ------------------------------------------------------------- |
| **ENV-01**   | Environment gate             | 0 — gate            | NOT RUN |      |        |          |                                                               |
| **ENV-02**   | Environment gate             | 0 — gate            | NOT RUN |      |        |          |                                                               |
| **ENV-03**   | Environment gate             | 0 — gate            | NOT RUN |      |        |          |                                                               |
| **ENV-04**   | Environment gate             | 0 — gate            | NOT RUN |      |        |          |                                                               |
| **ENV-05**   | Environment gate             | 0 — gate            | NOT RUN |      |        |          |                                                               |
| **ENV-06**   | Environment gate             | 0 — gate            | NOT RUN |      |        |          |                                                               |
| **ENV-07**   | Environment gate             | 0 — gate            | NOT RUN |      |        |          |                                                               |
| **ENV-08**   | Environment gate             | 0 — gate            | NOT RUN |      |        |          |                                                               |
| **BR-10**    | Security regression set      | 1 — security        | NOT RUN |      |        |          |                                                               |
| **BR-11**    | Security regression set      | 1 — security        | NOT RUN |      |        |          |                                                               |
| **BR-07**    | Security regression set      | 1 — security        | NOT RUN |      |        |          | BLOCKED until the branch-confined account is created — see §8 |
| **BR-12**    | Security regression set      | 1 — security        | NOT RUN |      |        |          | NEGATIVE check — crossing branches here is CORRECT            |
| **TEN-01**   | Tenant isolation             | 1 — security        | NOT RUN |      |        |          |                                                               |
| **DRIFT-01** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          |                                                               |
| **DRIFT-02** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          |                                                               |
| **DRIFT-03** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          | Pharmacist ONLY — a 403 means wrong account                   |
| **DRIFT-04** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          | Doctor + Lab tech + Pathologist                               |
| **DRIFT-05** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          | Doctor admits, Nurse transfers — two roles                    |
| **DRIFT-06** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          |                                                               |
| **DRIFT-07** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          |                                                               |
| **DRIFT-08** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          |                                                               |
| **DRIFT-09** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          |                                                               |
| **DRIFT-10** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          |                                                               |
| **DRIFT-11** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          |                                                               |
| **DRIFT-12** | Schema drift / 503 refusals  | 2 — clinical safety | NOT RUN |      |        |          |                                                               |
| **PERM-01**  | Permission matrix (API)      | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **PERM-02**  | Permission matrix (API)      | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **PERM-03**  | Permission matrix (API)      | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **PERM-04**  | Permission matrix (API)      | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **PERM-05**  | Permission matrix (API)      | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **PERM-06**  | Permission matrix (API)      | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **PERM-07**  | Permission matrix (API)      | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **PERM-08**  | Permission matrix (API)      | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **PERM-09**  | Permission matrix (API)      | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **PERM-10**  | Permission matrix (API)      | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-01**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-02**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-03**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-04**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-05**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-06**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-07**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-08**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-09**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-10**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-11**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-12**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-13**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          |                                                               |
| **NEG-14**   | Negative / falsification     | 3 — permissions     | NOT RUN |      |        |          | KNOWN DEFECT D4 — record, do not re-report                    |
| **WEB-01**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-02**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-03**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-04**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-05**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-06**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-07**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-08**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-09**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-10**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-11**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-12**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-13**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-14**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-15**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-16**   | Web validation               | 4 — web             | NOT RUN |      |        |          | Needs TWO devices and TWO identities                          |
| **WEB-17**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-18**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-19**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-20**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-21**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-22**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-23**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **WEB-24**   | Web validation               | 4 — web             | NOT RUN |      |        |          |                                                               |
| **JR-01**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-02**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-03**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-04**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-05**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-06**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-07**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-08**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-09**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-10**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-11**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-12**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-13**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-14**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-15**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-16**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-17**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-18**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-19**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-20**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-21**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **JR-22**    | Clinical journey (§13A)      | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **DUP-01**   | Duplicate-submission control | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **DUP-02**   | Duplicate-submission control | 5 — journey         | NOT RUN |      |        |          |                                                               |
| **MAR-01**   | MAR safety / concurrency     | 6 — concurrency     | NOT RUN |      |        |          |                                                               |
| **MAR-02**   | MAR safety / concurrency     | 6 — concurrency     | NOT RUN |      |        |          | Needs TWO devices and TWO identities                          |
| **MAR-03**   | MAR safety / concurrency     | 6 — concurrency     | NOT RUN |      |        |          |                                                               |
| **MAR-04**   | MAR safety / concurrency     | 6 — concurrency     | NOT RUN |      |        |          | PRN — BOTH must succeed; a refusal is a P1                    |
| **MAR-05**   | MAR safety / concurrency     | 6 — concurrency     | NOT RUN |      |        |          |                                                               |
| **FR-01**    | The five rights              | 6 — concurrency     | NOT RUN |      |        |          |                                                               |
| **FR-02**    | The five rights              | 6 — concurrency     | NOT RUN |      |        |          |                                                               |
| **FR-03**    | The five rights              | 6 — concurrency     | NOT RUN |      |        |          |                                                               |
| **LR-01**    | Lost response                | 7 — network         | NOT RUN |      |        |          |                                                               |
| **LR-02**    | Lost response                | 7 — network         | NOT RUN |      |        |          |                                                               |
| **LR-03**    | Lost response                | 7 — network         | NOT RUN |      |        |          |                                                               |
| **LR-04**    | Lost response                | 7 — network         | NOT RUN |      |        |          |                                                               |
| **LR-05**    | Lost response                | 7 — network         | NOT RUN |      |        |          |                                                               |
| **LR-06**    | Lost response                | 7 — network         | NOT RUN |      |        |          |                                                               |
| **NET-01**   | Network matrix               | 7 — network         | NOT RUN |      |        |          |                                                               |
| **NET-02**   | Network matrix               | 7 — network         | NOT RUN |      |        |          |                                                               |
| **NET-03**   | Network matrix               | 7 — network         | NOT RUN |      |        |          |                                                               |
| **NET-04**   | Network matrix               | 7 — network         | NOT RUN |      |        |          |                                                               |
| **NET-05**   | Network matrix               | 7 — network         | NOT RUN |      |        |          |                                                               |
| **NET-06**   | Network matrix               | 7 — network         | NOT RUN |      |        |          |                                                               |
| **NET-07**   | Network matrix               | 7 — network         | NOT RUN |      |        |          |                                                               |
| **NET-08**   | Network matrix               | 7 — network         | NOT RUN |      |        |          |                                                               |
| **NET-09**   | Network matrix               | 7 — network         | NOT RUN |      |        |          |                                                               |
| **BR-01**    | Branch isolation, remainder  | 8 — branch          | NOT RUN |      |        |          |                                                               |
| **BR-02**    | Branch isolation, remainder  | 8 — branch          | NOT RUN |      |        |          |                                                               |
| **BR-03**    | Branch isolation, remainder  | 8 — branch          | NOT RUN |      |        |          |                                                               |
| **BR-04**    | Branch isolation, remainder  | 8 — branch          | NOT RUN |      |        |          |                                                               |
| **BR-05**    | Branch isolation, remainder  | 8 — branch          | NOT RUN |      |        |          | Regression check — expect refusal, not rows                   |
| **BR-06**    | Branch isolation, remainder  | 8 — branch          | NOT RUN |      |        |          |                                                               |
| **BR-08**    | Branch isolation, remainder  | 8 — branch          | NOT RUN |      |        |          |                                                               |
| **BR-09**    | Branch isolation, remainder  | 8 — branch          | NOT RUN |      |        |          | KNOWN DEFECT D4 — record, do not re-report                    |
| **TZ-01**    | Timezone                     | 9 — timezone        | NOT RUN |      |        |          |                                                               |
| **TZ-02**    | Timezone                     | 9 — timezone        | NOT RUN |      |        |          |                                                               |
| **TZ-03**    | Timezone                     | 9 — timezone        | NOT RUN |      |        |          |                                                               |
| **TZ-04**    | Timezone                     | 9 — timezone        | NOT RUN |      |        |          |                                                               |
| **TZ-05**    | Timezone                     | 9 — timezone        | NOT RUN |      |        |          |                                                               |
| **TZ-06**    | Timezone                     | 9 — timezone        | NOT RUN |      |        |          |                                                               |
| **TZ-07**    | Timezone                     | 9 — timezone        | NOT RUN |      |        |          |                                                               |
| **TZ-08**    | Timezone                     | 9 — timezone        | NOT RUN |      |        |          | Regression check — expected result INVERTED 2026-08-16        |
| **TZ-09**    | Timezone                     | 9 — timezone        | NOT RUN |      |        |          | Regression check — money                                      |
| **M2-01**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-02**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-03**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          | N/A if no MFA account exists — say so                         |
| **M2-04**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-05**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-06**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-07**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-08**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-09**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-10**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-11**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-12**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-13**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-14**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-15**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-16**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-17**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-18**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-19**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-20**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-21**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-22**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-23**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-24**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-25**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-26**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-27**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-28**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-29**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-30**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-31**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-32**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-33**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-34**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-35**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-36**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-37**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-38**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-39**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-40**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-41**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-42**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-43**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-44**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-45**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-46**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-47**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-48**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-49**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-50**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-51**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M2-52**    | M2 doctor mobile             | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-01**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-02**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-03**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-04**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-05**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-06**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-07**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-08**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-09**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-10**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-11**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-12**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-13**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-14**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-15**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-16**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-17**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-18**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-19**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-20**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-21**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-22**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-23**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-24**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-25**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-26**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-27**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-28**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-29**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-30**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-31**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-32**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-33**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          | PRODUCT DECISION REQUIRED — not a defect                      |
| **M3-34**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-35**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          | Needs TWO devices and TWO identities                          |
| **M3-36**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **M3-37**    | M3 nurse mobile              | 10 — mobile         | NOT RUN |      |        |          |                                                               |
| **LIC-01**   | Licence / edition            | 11 — licence        | NOT RUN |      |        |          |                                                               |
| **LIC-02**   | Licence / edition            | 11 — licence        | NOT RUN |      |        |          |                                                               |
| **LIC-03**   | Licence / edition            | 11 — licence        | NOT RUN |      |        |          |                                                               |
| **LIC-04**   | Licence / edition            | 11 — licence        | NOT RUN |      |        |          |                                                               |
| **LIC-05**   | Licence / edition            | 11 — licence        | NOT RUN |      |        |          |                                                               |
| **LIC-06**   | Licence / edition            | 11 — licence        | NOT RUN |      |        |          | BLOCKED — needs an edition without the nursing module         |

### Totals

| Phase                                             | Rows    |
| ------------------------------------------------- | ------- |
| 0 — gate (ENV)                                    | 8       |
| 1 — security (BR-10, BR-11, BR-07, BR-12, TEN-01) | 5       |
| 2 — clinical safety (DRIFT)                       | 12      |
| 3 — permissions (PERM, NEG)                       | 24      |
| 4 — web (WEB)                                     | 24      |
| 5 — journey (JR, DUP)                             | 24      |
| 6 — concurrency (MAR, FR)                         | 8       |
| 7 — network (LR, NET)                             | 15      |
| 8 — branch remainder (BR)                         | 8       |
| 9 — timezone (TZ)                                 | 9       |
| 10 — mobile (M2, M3)                              | 89      |
| 11 — licence (LIC)                                | 6       |
| **TOTAL**                                         | **232** |

---

## 31. Recommended Execution Order

This order is the runbook's §5.0 followed by §5.1, with the dependencies it states preserved. Where
it differs from the obvious order, the reason is given — **deviate if you have a reason, and write
the reason down.**

| #        | Phase                                | Rows                          | Why here                                                                                                                                                                                                                                                          |
| -------- | ------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**    | **Environment verification**         | ENV-01…ENV-08                 | 🔴 **A gate.** Nothing downstream is meaningful without it. **If ENV-04 does not print READY, stop.**                                                                                                                                                             |
| **2**    | **BR-10**                            | BR-10                         | 🔴 **The least clickable row in the campaign.** The list was already scoped, so the UI never offered the link while the API served the PDF. A tester following screens would report everything as working.                                                        |
| **3**    | **BR-11**                            | BR-11                         | The only confirmed cross-branch **write**. **Read its trap first** — before the fix the first call succeeded and the next two returned 422, which looks exactly like a working boundary.                                                                          |
| **4**    | **Create the branch-confined nurse** | —                             | §8.1. No code change; a tenant admin and five minutes.                                                                                                                                                                                                            |
| **5**    | **BR-07**                            | BR-07                         | The account with the least coverage in the product, and the one the audit's findings all lived behind.                                                                                                                                                            |
| **6**    | **TEN-01**                           | TEN-01                        | Cheap, and its failure mode is the most serious in the document.                                                                                                                                                                                                  |
| **7**    | **BR-12**                            | BR-12                         | The **negative control** — the wallet advance is hospital-wide **on purpose**. It is here so nobody "fixes" it.                                                                                                                                                   |
| **8–14** | **DRIFT-01 … DRIFT-12**              | 12 rows                       | Five clinical refusals **no human has ever seen on a screen**. DRIFT-10 is the row most likely to find something real.                                                                                                                                            |
| **15**   | **Permissions by API**               | PERM-01…10, NEG-01…14         | ⚠️ **Runbook §5.1 moves this EARLY, and §13A requires it before the journey.** ~15 minutes of `curl`, and it tells you the role model you are about to trust is intact. **Finding a permission hole _after_ a day of role-based UI testing invalidates the day.** |
| **16**   | **Web**                              | WEB-01…24                     | Moved **before** mobile: no build, no device, no pairing. And it is the **less** proven surface — web defects D-1 and D-2 were fixed and have **never been opened in a browser**. Highest defect probability per minute of effort.                                |
| **17**   | **The clinical journey**             | JR-01…22, DUP-01/02           | 🔴 **Must run after §5.0 and after permissions, and before mobile.** It is one continuous patient, so a failure early on blocks the rest — **the only section where that is intended.**                                                                           |
| **18**   | **M2 foundation gate**               | M2-01…M2-12                   | The prerequisite for anything auth-, session- or branch-related in M3.                                                                                                                                                                                            |
| **19**   | **M3 core**                          | M3-01…M3-27                   | The nurse's ordinary shift.                                                                                                                                                                                                                                       |
| **20**   | **MAR safety + five rights**         | MAR-01…05, FR-01…03, M3-28…37 | 🔴 **The reason the product was built this way.** Needs two people and full attention — **do it fresh, not at 18:00.**                                                                                                                                            |
| **21**   | **Lost response**                    | LR-01…06, NET-01…09           | Needs a cooperative radio and steady hands. **Do it while still fresh.**                                                                                                                                                                                          |
| **22**   | **Branch isolation, remainder**      | BR-01…06, BR-08, BR-09        | The security rows were already done in phases 2–7. **BR-05 is now a regression check — expect a refusal, not rows.**                                                                                                                                              |
| **23**   | **Timezone**                         | TZ-01…TZ-09                   | ⏰ **Some rows are only meaningful near a midnight** — plan around the clock rather than the checklist order.                                                                                                                                                     |
| **24**   | **M2 remainder**                     | M2-13…M2-52                   | The biometric lock (**the largest unverified block in M2**), accessibility, network.                                                                                                                                                                              |
| **25**   | **Licence / edition**                | LIC-01…LIC-06                 | LIC-01…05 prepared via `pnpm seed:licence`. **LIC-06 stays BLOCKED.**                                                                                                                                                                                             |
| **26**   | **Final regression pass**            | —                             | Re-run `pnpm seed:validation -- --verify`. **It must still say READY.**                                                                                                                                                                                           |

### 🔴 Dependencies you must not reorder

1. **ENV-04 before everything.** If it does not print READY, every clinical result afterwards is
   **void**.
2. **If BR-10, BR-11 or BR-07 fails, STOP and report before continuing.** They are regression checks
   on fixes that are days old.
3. **Permissions (§26) before the journey (§19).** Runbook §13A states it explicitly, and §5.1 gives
   the reason.
4. **The journey is one continuous patient**, in order, at branch A. JR-06 depends on JR-05; JR-13
   depends on JR-08; JR-20 depends on the times you recorded at JR-13 and JR-18.
5. **Every DRIFT drop is recovered in the same session** (§11.3), and `--check` must print `READY`
   before you move on.
6. **M2-01…M2-12 before any M3 row.**

> **Note on ordering.** The runbook's §5.0 puts DRIFT before BR-12; the order above puts BR-12 first
> because it is a two-minute negative control and DRIFT is a long, stateful block. **Neither creates
> a dependency the other needs** — both orderings satisfy every constraint in the list above. If you
> prefer the runbook's exact sequence, use it and note the choice.

---

# PART I — SESSION CHECKLIST

## 32. Before and after

### Before each session

```
[ ] Docker Desktop running; pnpm docker:dev up; no container Exited (137)
[ ] pnpm dev running
[ ] curl /health returned 200
[ ] pnpm seed:migrate --check said READY
[ ] pnpm seed:validation -- --verify said READY   ← output saved to the results file
[ ] git tree clean — no code changed since the last session
[ ] Correct tenant (sunrise, unless the row says district or licence-lab)
[ ] Correct branch showing in the top bar
[ ] Correct user signed in for the first row
[ ] Prerequisite for the first row confirmed
[ ] Test ID written at the top of the page
[ ] Screenshot folder open and named for today
```

### Before each test

```
[ ] I have read the row in the RUNBOOK, not only in this guide
[ ] I know which account it needs, and I am signed in as that account
[ ] I know which branch it needs, and the top bar agrees
[ ] The prerequisite is true (due scheduled dose / signed Rx / free bed / …)
[ ] I have counted anything the row asks me to count BEFORE acting
[ ] If it is irreversible, I have captured the previous step's evidence
```

### After each test

```
[ ] Result recorded — PASS / FAIL / BLOCKED (never blank, never "probably")
[ ] Evidence saved and named with the test ID
[ ] Data restored if the test dropped an index (--check printed READY)
[ ] User and branch confirmed for the NEXT row
[ ] No production data was touched
[ ] If it FAILED: §29 followed in order, and it is NOT marked PASS
```

### At the end of every session

```
[ ] pnpm seed:validation -- --verify run again — still READY
[ ] Every index dropped today has been recreated
[ ] The tracker updated for every row attempted
[ ] Anything surprising written down, even if it passed
[ ] No unfinished drift left in any tenant
```

---

# PART J — FINAL READINESS

## 33. When Are We Done?

### Manual validation is complete only when

1. **Every applicable row has a result** — PASS, FAIL or BLOCKED. **No blanks, no "probably".**
2. **No unexplained P0 or P1 remains.** Each is either fixed, or accepted with a written decision.
3. **Every FAIL has been investigated** — root cause understood, not just observed.
4. **Every BLOCKED row has a documented reason** — which hardware, which prerequisite, which account.
5. **Evidence exists for every security-critical row** — BR-07, BR-10, BR-11, BR-12, TEN-01, and
   every DRIFT row.
6. **A final regression pass has been performed** and `--verify` still says READY.

### The three statuses, and why they are separate

**Do not collapse these into one number.** Each answers a different question, and only the third one
decides whether a patient's record is safe in this system.

| Status                    | Answers                                                                                           | Right now                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AUTOMATED ENGINEERING** | _Can the server enforce the rules?_                                                               | ✅ **GREEN** — full gate green end to end, integration 1842/1842, T3 root cause proven and fixed                                                                     |
| **MANUAL VALIDATION**     | _Does a real person, on a real screen, get told the truth — and get stopped when they should be?_ | 🔴 **REQUIRED — 0 of 232 rows executed**                                                                                                                             |
| **PILOT READINESS**       | _Can this run a hospital?_                                                                        | 🔴 **NOT READY** — manual validation is one input; deployment readiness (VPS, log rotation, off-site backup, restore rehearsal) is another and is tracked separately |

> 🔴 **A green automated gate is not a validated product, and a validated product is not a deployed
> one.** Keep the three apart in every report you write. The whole point of this campaign is that the
> first status cannot answer the second one's question.

---

## 34. Ambiguities and Source Inconsistencies Found While Writing This Guide

**Every one of these preserves the runbook's original requirement.** Nothing was renumbered, no
expected result was changed, and no test was dropped. They are recorded here so a reader who spots
the same thing knows it was seen deliberately.

| #     | Where                        | The issue                                                                                                                                                                                                                                      | What this guide does                                                                                                                                                                             |
| ----- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A** | **BR-07 status**             | Runbook §19.2 (D1 row) says _"BR-07 is no longer blocked: the branch-confined case is proven by test"_, while BR-07's own row says **BLOCKED** and §22 item 3 says it is _"empirically unproven through a UI"_.                                | **Preserved as BLOCKED** until the account is created. The §19.2 line is about **automated** coverage; the **manual** row still needs a real account and a real screen. §8 states both readings. |
| **B** | **BR-07 account creation**   | The runbook says _"via the roles UI"_. In the current web app the branch binding is on the **Staff** page (`/staff`), not `/roles`. Verified in `apps/web/app/staff/page.tsx`.                                                                 | **Requirement unchanged** — a tenant admin creates a branch-confined nurse, no code change. **Only the location is clarified**, with the exact on-screen labels.                                 |
| **C** | **Branch B's name**          | The runbook calls it _"second site"_ and never names it. The seed creates **"Riverside Annexe"** (code `RIVERSIDE`) — **but it _adopts_ an existing site instead if the hospital's branch cap is reached**, and says so on the line it prints. | Named here **and** the guide tells you to read it from your own seed output rather than trusting the name.                                                                                       |
| **D** | **Getting a branch id**      | §15.3's template needs `<BRANCH_A_ID>` but the runbook never says where to get it. `GET /branches` requires `branch:manage`, which a nurse does not hold — a beginner would get a `403` and think something was broken.                        | §5.4 uses **`GET /me/branches`**, the switcher's own endpoint: authenticated, no permission required.                                                                                            |
| **E** | **BR-11's actor**            | The row says _"a branch-B clerk holding `appointment:cancel` / `appointment:update`"_ but §4 does not say which account that is.                                                                                                               | Identified as the **Receptionist** — verified in `packages/permissions/src/index.ts`, where RECEPTIONIST holds `appointment:create/read/update/cancel`. **No new account invented.**             |
| **F** | **New staff credentials**    | The runbook does not mention that a staff account created in the UI gets a **temporary password shown once**, and may require a password change on first login (`mustChangePassword` exists in the auth contract).                             | §8.1 warns to copy it immediately, and §8.2 covers the forced change. **This is normal behaviour, not a defect.**                                                                                |
| **G** | **Execution order**          | The runbook's §5.0 sequences BR-12 **after** DRIFT; a natural reading of "run the security set first" puts it before.                                                                                                                          | Both orderings satisfy every stated dependency. §31 notes the difference and says to record whichever you use.                                                                                   |
| **H** | **DRIFT-08's second tenant** | The row says _"the same act, tenant `district`"_ but does not name an account for it.                                                                                                                                                          | §18 uses `district`'s own seeded admin. **If the act you refused in `sunrise` needs a specific role, use `district`'s account of that same role.**                                               |
| **I** | **`--verify` invocation**    | The runbook writes it both as `pnpm seed:validation -- --verify` and `pnpm seed:validation --verify`.                                                                                                                                          | The `--` form is used throughout this guide, matching the root `package.json` script definition.                                                                                                 |

### Two things the runbook says that this guide deliberately repeats verbatim

1. **"No result in this document is a result. Every row is unexecuted."** That was true of the
   runbook when it was written and it is true of this guide now.
2. **"Expected results are drawn from the implementation and its comments. Where the implementation
   is self-consistent but the intent is unstated, the row says PRODUCT DECISION REQUIRED rather than
   guessing. Those are decisions for people, not for a tester and not for an agent."**

### What neither document can tell you

- **These pages have no manual coverage at all** and are not in this guide: `/mrd`, `/mortuary`,
  `/theatres`, `/ambulance`, `/assets`, `/insurance`, `/packages`, `/tariff`, `/feedback`, `/audit`,
  `/subscription`, `/reports`. Some are deliberate (audit and subscription are operator surfaces);
  the rest are simply **untested by hand**. 🔴 **Say so in your campaign report rather than letting a
  green run imply the product was covered.**
- **The journey (§19) is one pass over each flow, not coverage of any of them.** It walks each flow
  **once**, on the happy path plus four refusals. It proves the flows connect and the guards fire. It
  is **not** a functional test of billing, of scheduling, or of the lab.
- **The environment gate covers one tenant at one moment.** Fleet-wide convergence (risk **T2**)
  remains open and is not addressed by anything you will do here.

---

_Companion to [`docs/MANUAL_VALIDATION_RUNBOOK.md`](docs/MANUAL_VALIDATION_RUNBOOK.md), which remains
authoritative for every test ID and expected result. Written 2026-08-17. **No row in this document
has been executed.**_
