# TESTING — How to run and test locally

> ### 👉 New here or feeling lost? Read only **Section 0** below.
>
> Everything after it (Ports, replica sets, 47 numbered scenarios…) is **reference**.
> You do **not** need any of it to start testing. Come back to it when you want detail on
> one specific feature.

---

## 0. The simple guide — walk one patient through the hospital (15 min)

This is the whole product in one story: a patient arrives, sees a doctor, gets a test and a
medicine, and pays. You will log in as a different staff member at each step — that is the point.

### Step 1 · Start it (do this once)

Open **three terminals** in the project folder and run one command in each, in order:

```bash
pnpm docker:dev    # terminal 1 · the databases (leave it running)
pnpm dev           # terminal 2 · the actual app  (leave it running)
pnpm verify        # terminal 3 · "is it working?" — run anytime
```

The **first time only**, load the demo hospital (two hospitals, staff, prices) in a 4th terminal:

```bash
pnpm --filter @medicore/api migrate --all    # set up the database (safe to re-run)
pnpm --filter @medicore/api seed:demo         # operator + 2 hospitals + staff + prices + drugs
pnpm --filter @medicore/api seed:clinical     # OPTIONAL: fill Sunrise with demo patients & visits
```

**You only seed once.** The data lives in the database and survives restarts — `pnpm dev` never
touches it. Re-seed only if you wipe the database (a fresh machine, or `docker:dev:down` with
volumes removed). All three commands above are safe to re-run.

- `seed:demo` creates the login accounts, both hospitals, the price list and the drug list — but
  **no patients**.
- `seed:clinical` (optional) adds ~6 patients to **Sunrise**, already spread across the flow: some
  waiting in the doctor's queue, some mid-consult, some with tests at the lab. Run it with
  `pnpm dev` up so the bills catch up. Great if you don't want to register patients by hand first.

> **If anything looks broken, run `pnpm verify` first.** It checks everything and prints the
> _fix_, not the error. Don't debug the login screen by hand.

### Step 2 · Open the hospital

|                         |                                   |
| ----------------------- | --------------------------------- |
| **Open this**           | **http://sunrise.localhost:3000** |
| **Password (everyone)** | `123456`                          |

The web address **is** the hospital — `sunrise.localhost` is "Sunrise Hospital". (There's a second
demo hospital, a free government one, at `district.localhost:3000` — same steps, every price ₹0.)

You'll log in as these people. Use one browser tab per person, **or** just log out and back in
between steps:

| Log in as                  | This person is…                     |
| -------------------------- | ----------------------------------- |
| `reception@sunrise.test`   | the front desk                      |
| `drrao@sunrise.test`       | the doctor (Dr Rao)                 |
| `cashier@sunrise.test`     | the billing counter                 |
| `labtech@sunrise.test`     | the lab technician                  |
| `pathologist@sunrise.test` | the senior who approves lab results |
| `pharmacy@sunrise.test`    | the pharmacy counter                |

### Step 3 · The walkthrough

Follow it top to bottom. Each step says **who to log in as**, **what to do**, and ✅ **what you
should see** (so you know it worked).

**1. Reception registers the patient** — log in as `reception@sunrise.test`, open **Reception**.

- Register a walk-in, pick **Dr Rao**, click **Add to queue**.
- ✅ The patient appears in the day's list, and a ₹500 consultation fee shows on their bill.

**2. Cashier takes the consultation fee** — log in as `cashier@sunrise.test`, open **Billing**.

- Find the patient, **Finalize** the bill, then **Collect payment**.
- ✅ The bill is marked paid. (A government hospital's ₹0 bill is paid the moment it's finalized.)

**3. Doctor sees the patient and orders a test** — log in as `drrao@sunrise.test`, open **My patients**.

- You only see _your own_ patients. Click the patient → **Call in**.
- In the **Order** section, tap a test (e.g. **CBC** or **Chest X-ray**), then **Order 1 test**.
- ✅ It says the test is on the department's worklist. You can tap more tests and order again —
  add as many as you like.
- When you're done ordering, click **Send for tests** (the button above).
- ✅ **New:** if you ordered _nothing_, **Send for tests** is greyed out — you must order at
  least one test first. Once you've ordered one, it works and the patient moves to "at the lab".

**4. Cashier takes payment for the test** — log in as `cashier@sunrise.test`, open **Billing**.

- **Finalize** and **Collect payment** for the new test charge.
- ✅ Paid. This is what lets the lab actually run the test. Tests ordered _after_ this payment
  become a separate bill — that's by design.

**5. Lab runs the test** — log in as `labtech@sunrise.test`, open **Worklist**.

- The test is _already there_ (nobody "sent" it — it appeared the moment it was ordered).
- **Accept** → **Start** → enter a result.
- ✅ It says "awaiting verification — not yet visible to the doctor". A lab tech can't approve
  their own work.

**6. Pathologist approves the result** — log in as `pathologist@sunrise.test`, open **Worklist**.

- **Verify** → **Release**.
- ✅ Only now can the doctor see the number, and the patient returns to the doctor's list
  automatically.

**7. Doctor prescribes a medicine** — back as `drrao@sunrise.test`, open the patient.

- In **Prescribe**, pick a drug, set dose / route / frequency / days / quantity, **Sign**.
- ✅ It's now on the pharmacy counter. Nothing is charged yet — medicine is billed only when
  it's actually handed over.

**8. Pharmacy dispenses** — log in as `pharmacy@sunrise.test`, open **Pharmacy**.

- The prescription is already there. Hand over some (e.g. 6 of 10), **Dispense**.
- ✅ The badge shows "6/10 given", and the patient is billed for 6, not 10.

**That's the full loop.** The one idea behind all of it: **nothing is ever "sent" anywhere** —
work shows up in the next department the instant it's created. The one exception you just used,
"Send for tests", only moves the _patient_ to a waiting state; the tests were already at the lab.

### Logging in as the platform operator (a different app)

The hospital app (`sunrise.localhost:3000`) and the **operator console** are two separate apps with
two separate user lists. The console is where the _software company_ creates and manages hospitals —
not a hospital login.

|               |                                                                    |
| ------------- | ------------------------------------------------------------------ |
| **Open this** | **http://localhost:3001** (the operator console, a different port) |
| **Email**     | `ops@paperlesstech.in`                                             |
| **Password**  | `123456`                                                           |

There is **only one** seeded operator: `ops@paperlesstech.in`. An email like `nasar@paperlesstech.in`
does not exist until you create it, and logging in with it just fails — the error is deliberately the
same for a wrong password, an unknown email, and a disabled account, so it always _looks_ like a
password problem. To add another operator, log in as `ops@…` first and create it from the console
(the bootstrap CLI only works on a brand-new database with no operators yet).

### If you get stuck

| Problem                                      | Do this                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| Login page won't load / "can't connect"      | Run `pnpm verify` — it names the cause and the fix.                        |
| Blank page at `localhost:3000`               | Use `sunrise.localhost:3000`. Plain `localhost` is "no hospital".          |
| "No patients" as the doctor                  | Reception must register one **and pick that doctor** first.                |
| Rx pad (prescribe) is empty                  | Run `pnpm --filter @medicore/api migrate --all` — it loads the drug list.  |
| A number seems ~1–2s behind after dispensing | Normal — billing catches up a moment later. Don't take payment off it yet. |

### Where to go next (reference sections below)

- **Section 1d** — the same demo in more depth, plus "try to break it" security tests.
- **Section 1** — ports and URLs, if a port is taken.
- **Sections 23–47** — one feature at a time (wallet, express visits, receipts, vitals, branches…).

---

**Start here: open http://demo.localhost:3000 and sign in.** That is the app.

Two things trip everyone up:

1. **`pnpm docker:dev` does not start the application.** It starts only the _infrastructure_ (databases, cache, storage, mail). You start the apps with `pnpm dev`.
2. **Do not browse `localhost:3000`.** The hostname IS the hospital — `demo.localhost` means the demo hospital, and plain `localhost` means no hospital at all. `<slug>.localhost` resolves to your machine automatically; you do not need to edit any hosts file.

```
pnpm docker:dev   →  mongo, redis, minio, mailhog        (infrastructure)
pnpm dev          →  api, workers, web, admin            (the actual apps)
```

Run both, in that order, in two terminals.

---

## 1. Ports

| What                    | Port    | URL                                                | Started by        |
| ----------------------- | ------- | -------------------------------------------------- | ----------------- |
| **API (Express)**       | `4000`  | http://localhost:4000/health                       | `pnpm dev`        |
| Workers (BullMQ)        | `4100`  | http://localhost:4100/health                       | `pnpm dev`        |
| Web (Next.js)           | `3000`  | http://localhost:3000                              | `pnpm dev`        |
| Admin console (Next.js) | `3001`  | http://localhost:3001                              | `pnpm dev`        |
| MongoDB                 | `37018` | `mongodb://127.0.0.1:37018/?directConnection=true` | `pnpm docker:dev` |
| Redis                   | `6380`  | `redis://127.0.0.1:6380`                           | `pnpm docker:dev` |
| Mailhog (fake inbox)    | `8025`  | http://localhost:8025                              | `pnpm docker:dev` |
| MinIO console (S3)      | `9001`  | http://localhost:9001 (`minioadmin`/`minioadmin`)  | `pnpm docker:dev` |

**Mongo is on 37018 and Redis on 6380, not their defaults.** Another project on this machine (the School ERP) uses 27017 for its local Mongo and 27018 for an SSH tunnel to its VPS. HMS owns `37018`, which nothing else touches — see [infra/docker/LOCAL_PORTS.md](infra/docker/LOCAL_PORTS.md). Do not "fix" these back.

**Mongo is 37018 on _both_ sides of the container — that one is load-bearing, not cosmetic.** A replica-set client follows the address the server advertises rather than the one you typed. If mongod listened on the conventional 27017 internally it would advertise `localhost:27017`, which from the host is the _School ERP's_ Mongo — and since replica sets are named `rs0` by default, the driver could follow it there believing it had found our primary. Publishing `37018:37018` makes the advertised address true from inside and outside, so discovery resolves back to us; naming the set **`hms0`** (not `rs0`) means a `replicaSet=hms0` client rejects a stranger's `rs0` outright. Changing the internal port re-opens the first hole.

### If a port is still taken

Override it — never edit the compose file, because 37018/6380 are also baked into `.env.example` and the docs:

```bash
MONGO_PORT=37019 REDIS_PORT=6381 pnpm docker:dev
# then point apps/api/.env at the same ports (MONGO_URI and MONGO_EXPECT_MEMBER)
```

Overriding `MONGO_PORT` breaks the both-sides-equal property above: the host would publish 37019 while the replica set still advertises 37018, so topology discovery points at a port that has nothing on it. Every URI in this repo carries `directConnection=true`, which skips discovery, so this is survivable — but a bare URI in Compass will fail until you also map the container's 37018 to the same number.

### The port trap that nearly cost us a database

**A loopback address does not prove the database is local.** An SSH tunnel like `ssh -L 37018:127.0.0.1:27017 user@remote` binds _our_ port on `127.0.0.1` and quietly wins the bind over Docker — after which everything connecting to `127.0.0.1:37018` is talking to a **remote** server. Our integration tests drop databases.

The harness now refuses to run unless the target is loopback **and** has no authentication (the dev container runs open; real servers don't), and it will only ever drop databases named `test_*` or `hms_test-*`. If you see `REFUSING TO RUN`, something else has taken the port:

```bash
lsof -nP -iTCP:37018 -sTCP:LISTEN     # an SSH tunnel? another container?
docker ps
```

**Almost all API testing happens on port 4000.** The web apps (3000/3001) currently render a health page only — there is no login screen yet, because Phase 1B built the authentication _backend_. The login UI arrives with the app shell.

---

## 1b. Using the app (the short version)

```bash
pnpm docker:dev     # terminal 1 — infrastructure
pnpm dev            # terminal 2 — the apps
pnpm verify         # terminal 3 — is it actually working?

lsof -nP -iTCP:3000,3001,4000,4100 -sTCP:LISTEN   # we can check the processes later we can kill those using
kill -9 37477 73596 79705 79706
```

**`pnpm verify` is the answer to "why isn't it working".** It checks the containers, DNS, the API _on the address the browser will use_, the web app, CORS, and then performs a real login — and prints the fix, not the symptom:

```
  MediCore — local stack  (hospital: demo)

  ✔ Infrastructure (Mongo + Redis)     both containers up
  ✔ DNS: demo.localhost                resolves to ::1, 127.0.0.1
  ✔ API on http://demo.localhost:4000  HTTP 200
  ✔ Web on http://demo.localhost:3000  HTTP 200
  ✔ CORS preflight                     allows http://demo.localhost:3000
  ✔ Login as admin@demo.test           signed in as Administrator

  Everything works. Sign in at http://demo.localhost:3000
```

When something fails it names the cause and the command that fixes it. Never debug the login screen by hand again — run this first. (`pnpm verify apollo` checks a different hospital.)

Then open **http://demo.localhost:3000** and sign in with the demo hospital's admin:

|          |                            |
| -------- | -------------------------- |
| URL      | http://demo.localhost:3000 |
| Email    | `admin@demo.test`          |
| Password | `123456`                   |

(If that hospital doesn't exist yet, create it — see §4.)

You can then: add a colleague under **Staff** and give them a role, see the roles that exist, change your password, and sign devices out. Log in as the colleague you created and you will see a **smaller sidebar** — that is RBAC working: the menu shows only what their role permits, and the server refuses the rest regardless.

Then open **Activity trail**. Everything you just did is already in it — who, what, when, from which IP. Nothing you can do in the UI will remove an entry, because no code path exists that edits or deletes one.

**Never browse `demo.paperlesstech.in` locally.** That domain has wildcard DNS pointing at the real production server — you would be logging in to production, not your laptop. Locally it is always `.localhost`.

---

## 1c. Every dev password is `123456`

There is one password on the whole local platform. It is not a convention you have to remember — it is what the code generates:

| Account                                  | Where                       | Password |
| ---------------------------------------- | --------------------------- | -------- |
| Hospital admin (`admin@demo.test`)       | http://demo.localhost:3000  | `123456` |
| Operator (`ops@paperlesstech.in`)        | http://admin.localhost:3001 | `123456` |
| Any staff member you create              | the hospital app            | `123456` |
| Any hospital you create from the console | its own URL                 | `123456` |

`generatePassword()` — the single place any temporary password is minted — returns `DEV_DEFAULT_PASSWORD` when `NODE_ENV` is not `production`. There is no second code path, so no random password can leak back in.

## Why `123456` works locally (and cannot in production)

Local dev runs a deliberately weak password policy — 6 characters, no complexity — because typing a 12-character passphrase fifty times a day to test a login screen buys nothing on a throwaway laptop database. It is set in `apps/api/.env`:

```bash
PASSWORD_MIN_LENGTH=6
PASSWORD_REQUIRE_COMPLEXITY=false
```

**You cannot ship this.** When `NODE_ENV=production` the API _ignores_ both settings, restores the real policy (12 chars, mixed case, digit, symbol), and logs a `[SECURITY]` error naming the mistake. Try it:

```
[SECURITY] PASSWORD_MIN_LENGTH=6 is not permitted in production — using 12 instead
           (a hospital's records may not be protected by a PIN). Fix the configuration.
```

That guard is _why_ the local convenience is allowed to exist. A security property that depends on nobody making a configuration mistake is not a security property.

Everything that differs between local and production lives in **one file**: `apps/api/src/config/profiles.ts`. Secrets never go there (git history is forever) — those stay environment variables.

The API prints its effective configuration at boot, so you can always see what it actually decided:

```
api listening  profile=local  hospitalHosts=*.localhost  apiBind=:: (dual-stack)
               passwordPolicy=6+ chars, NO complexity (development only)
```

---

## 1d. THE CLINICAL DEMO — what you can actually test (updated 2026-07-16, after Slice 4)

**This is the section to read if you want to see the product.** Everything here has been driven
in a real browser as the actual role. If it is not listed in this section, assume it is not
built — and check §11, which says so explicitly.

```bash
pnpm --filter @medicore/api migrate --all   # safe to re-run; never overwrites a hospital's prices
pnpm --filter @medicore/api seed:demo       # two staffed hospitals, 9 logins each
pnpm dev
```

Then open **http://sunrise.localhost:3000**.

### The two hospitals — the whole demo in one comparison

Both run the **same code**. The only difference is `organizationType`, which selects a preset of
five policy switches. **There is no `if (government)` anywhere in the codebase** — a test greps
the source and fails if anyone ever writes one.

|          | **Sunrise Multispeciality**  | **District General**      |
| -------- | ---------------------------- | ------------------------- |
| URL      | `sunrise.localhost:3000`     | `district.localhost:3000` |
| Type     | Private hospital             | Government hospital       |
| Billing  | `prepaid` — the patient pays | `zero_tariff` — **₹0**    |
| Entry    | appointment or walk-in       | walk-in                   |
| Routing  | named doctor                 | department                |
| Pharmacy | in-house                     | in-house                  |

Run the identical flow at both. Sunrise bills **₹589.00**; District General bills **₹0.00**, with
the real prices still shown **struck through**. The patient pays nothing; the state still sees
what the care was worth. Free to the patient is not free to the exchequer.

### The nine logins (password `123456`, same at both hospitals)

| Login                      | Who                       | What they can do                         |
| -------------------------- | ------------------------- | ---------------------------------------- |
| `admin@sunrise.test`       | Hospital admin            | Everything except the 3 superadmin codes |
| `reception@sunrise.test`   | Front desk                | Register, queue, see the bill            |
| `drrao@sunrise.test`       | Dr Rao (General Medicine) | Consult, order, **prescribe**            |
| `drkhan@sunrise.test`      | Dr Khan (Surgery)         | Same, a different list                   |
| `labtech@sunrise.test`     | Lab technician            | Run tests. **Cannot verify**             |
| `pathologist@sunrise.test` | Pathologist               | **Verify + release** blood results       |
| `radiologist@sunrise.test` | Radiologist               | Verify + release **imaging**             |
| `pharmacy@sunrise.test`    | Nisha (Pharmacy)          | **Dispense**, see the bill               |
| `cashier@sunrise.test`     | Billing counter           | Finalize, take payment                   |

### The screens

| Screen            | Who sees it (permission)    | What it does                                                  |
| ----------------- | --------------------------- | ------------------------------------------------------------- |
| `/reception`      | `encounter:create`          | Walk-in intake, the day's register by date, the running bill  |
| `/my-patients`    | `order:create`              | Waiting list, call in, **order pad**, **Rx pad**, close visit |
| `/worklist`       | `order:read`                | Lab/imaging: accept → start → result → verify → release       |
| `/pharmacy`       | `pharmacy:dispense`         | The counter: what was prescribed, dispense (partial allowed)  |
| `/billing`        | `billing:read`              | Invoices, finalize, take payment                              |
| `/patients`       | `patient:read`              | The patient index                                             |
| `/appointments`   | `appointment:read`          | The appointment book                                          |
| `/staff`,`/roles` | `user:read` / `role:manage` | Staff directory and role grants                               |
| Activity trail    | `audit:read`                | Who did what, when, from where — append-only                  |

### The 5-minute flow — log in as each person in turn

**The point is that nobody ever "sends" anything anywhere.** Work appears in the next department
the instant it is committed. There is no "send to lab" button in this product, and that absence
is the feature.

1. **Reception** (`reception@…` → **Reception**) — register a walk-in, pick a doctor,
   **Add to queue**. The ₹500 consultation is on the bill immediately, posted on arrival.
   The date picker resolves in the _hospital's_ timezone.
2. **Doctor** (`drrao@…` → **My patients**) — your list only (filtered by the server).
   **Call in** → **Order** a CBC → **Prescribe**: pick a drug, set dose / route / frequency /
   days / quantity, **Sign**. Then **Send for tests**.
   - **No prices anywhere on this screen.** A doctor who can see what a patient owes may treat
     them differently. The order pad reads a price-free catalogue: _the rate card is not the bill._
   - `route` and `frequency` are dropdowns, not free text. A drug given by the wrong route kills
     people, and it has — repeatedly.
   - Signing makes it **immutable**. Changing a dose means **amend**: a new version supersedes it
     and the original survives exactly as signed.
3. **Lab tech** (`labtech@…` → **Worklist**) — the CBC is **already there**. Accept → Start →
   record the result (tick **critical** to see the panic path — the alert is sent synchronously,
   before verification). The tech sees _"Awaiting verification — not yet visible to the doctor"_.
   **They cannot verify their own work.**
4. **Pathologist** (`pathologist@…`) — **Verify** → **Release**. Only now can the doctor see the
   number. The patient returns to the doctor's list **automatically**, but only when _every_
   result is back. A pathologist **cannot** sign off an X-ray, and a radiologist cannot sign off blood.
5. **Pharmacy** (`pharmacy@…` → **Pharmacy**) — the prescription is **already at the counter**
   (the same object and the same query the lab uses). Set paracetamol to **6** of 10 and
   **Dispense**: the badge becomes `6/10 given`, "of 4 still owed", and **the patient is billed
   for 6, not 10**. Dispense the rest later and it bills again, correctly, as a _second_ charge.
   "Already handed over" is the ledger — who gave what, when.
6. **Admit them instead** (`drrao@…` → **My patients** → a patient who has been called in).
   Two extra buttons live under the patient:
   - **Transfer to another doctor** — pick Dr Khan, give a reason ("needs a surgical opinion").
     The reason is required: it is the handover note, and the only thing the receiving doctor
     has. Log in as `drkhan@…` and the patient is on **their** list, with the handover in the
     history. The orders and prescriptions do not move — they hang off the encounter.
   - **Admit to a bed** — pick a bed class (General Ward → ICU is 8× the price), type a bed
     number, admit. **This CLOSES the OP visit and opens an inpatient stay in the same care
     story.** Two encounters, one episode (ADR-0013 §4): OP and IP bill differently, and every
     census and ALOS number counts encounters.
7. **The ward** (`drrao@…`/`drkhan@…` → **Ward**) — everyone in a bed, with "day 1", "day 2".
   - Add a **progress note**. It cannot be edited or deleted afterwards — a correction is a new
     note. A record that can be rewritten is not evidence of anything.
   - **Discharge with a summary.** There is no way to discharge without one: diagnosis, what
     happened, advice. For a patient going back to a village clinic that document is the entire
     medical record of the stay.
   - The **bed-days land on the bill** at discharge — one charge per calendar day, from the day
     they came in.
8. **Cashier** (`cashier@…` → **Billing**) — consultation + tests + **only the drugs actually
   handed over** + the bed-days. **Finalize** (freezes it, assigns a number) → take payment.
   Overpayment is refused; a draft bill cannot be paid.
   - The OP visit and the IP stay have **separate bills** — that separation is what makes both
     of them billable at all.
9. **Do it all again at `district.localhost:3000`.** Same clicks, same code, **every line ₹0.00**
   with the real price struck through. A ₹0 invoice is marked paid the moment it is finalized —
   a government hospital must not accrue a pile of "unpaid" bills nobody will ever pay.

### Try to break it

All of these are enforced by the **database or the state machine**, not by a hopeful `if`:

| Try this                                            | What happens                                 | Why                                                                                |
| --------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Dispense 11 of 10 tablets                           | **Refused**                                  | The guard is in the query — two pharmacists both seeing "2 left" can't both give 2 |
| Dispense against an unsigned draft                  | **Refused**                                  | A draft is a doctor thinking out loud                                              |
| Doctor stops the drug, then dispense                | **Refused**                                  | They may have stopped it for an allergy. Already-given doses stay on the record    |
| Edit a signed prescription                          | **Refused**, and it names the way out        | It is a legal instrument the moment it is signed                                   |
| Double-click Order or Dispense                      | **One** order, **one** handover              | Idempotency key + unique index — the case a disabled button cannot save you from   |
| Sign an empty prescription                          | **Refused**                                  | A legal instrument authorising nothing                                             |
| As reception, open the order book or a prescription | Not in the nav; **403** if you force it      | A drug name is a diagnosis: lithium says bipolar, tenofovir says HIV               |
| As the pharmacist, try to write a prescription      | **403**                                      | They are the second pair of eyes, not the first                                    |
| As a doctor, try to verify your own lab result      | **403**                                      | You would be the only pair of eyes on it                                           |
| Prescribe a drug the patient is allergic to         | **Blocked** until you override with a reason | See "Allergy safety" below — the reason is recorded on the prescription            |

### Allergy safety — the newest thing to try (added 2026-07-16)

The prescribing pad now checks the patient's allergies before it will sign. To see it end to end:

1. As **Dr Rao** (`drrao@sunrise.test`), call a patient in and open their card. There is now an **Allergies** panel.
2. Record **Penicillins**, severity **severe**. It appears as a red badge, and a red "Allergies" banner appears on the Prescribe pad directly above the drug search — the information is in front of you before you prescribe.
3. Add **Amoxicillin** to the pad and press **Sign prescription**. Instead of signing, it stops and shows a red **CONTRAINDICATED** alert naming the drug and the allergy, with a box demanding a reason.
4. Type a reason and press **Override and sign**. It signs — and the reason, plus a snapshot of exactly what you were shown, is recorded on the prescription as a medicolegal fact. (Without a reason, the button stays disabled; the server refuses it too, so you cannot get past it by tampering with the page.)
5. As the **pharmacist** (`pharmacy@sunrise.test`), open that prescription on `/pharmacy`. The same red allergy banner is there — the last check before the drug leaves the shelf.

Things worth trying:

- **Rule the allergy out** (the ✕ on the badge, with a reason). Prescribing amoxicillin now signs with no block — a refuted allergy stays on the record but stops firing the check.
- **Prescribe two NSAIDs** (Ibuprofen + Diclofenac), or **Azithromycin + Ondansetron**. These WARN ("duplicate therapy", a QT-interaction) but do **not** block — only a direct allergy contraindication stops a signature. That severity ladder is deliberate: a system that blocks every warning teaches you to click past the one that matters.
- An allergy recorded at one branch is visible at another — it follows the patient, not the visit.

**What it is NOT:** a drug database. It is a curated net over the 15 demo drugs — no renal dosing, weight bands, pregnancy category or dose ceilings. The shape is real; the coverage is a demo. Do not present it to a hospital as a formulary.

### Known rough edges (real, not bugs to report)

- **The pharmacist's "this visit owes" lags ~1.5s** after dispensing. Billing _listens_ — the
  drug charge is posted once the relay delivers the event. It converges; it is not instant.
  **Do not take payment off that number yet.**
- **A new hospital's Rx pad is empty** until you run `migrate --all` — the drug tariff seeds there.
- **Two patients can be recorded in the same bed.** There is no bed inventory (see §11). The ward
  list shows who is admitted and where they were RECORDED; it cannot tell you which beds are free.

---

## 2. First-time setup (once)

```bash
pnpm install
pnpm docker:dev                       # infrastructure

cp apps/api/.env.example apps/api/.env
cp apps/workers/.env.example apps/workers/.env
cp apps/web/.env.example apps/web/.env
cp apps/admin/.env.example apps/admin/.env
```

Then put real secrets in `apps/api/.env` — **the API refuses to start without them**, on purpose (a default signing secret is how a dev key ends up in production):

```bash
openssl rand -base64 48    # paste as API_JWT_SECRET
openssl rand -base64 32    # paste as API_ENCRYPTION_KEY
```

> If `apps/api/.env` already has these two lines, you are done — they were generated for you.

---

## 3. Run it

```bash
# terminal 1 — infrastructure (leave running)
pnpm docker:dev

# terminal 2 — the apps
pnpm dev
```

Check it is alive:

```bash
curl http://localhost:4000/health     # {"status":"ok",...}          ← no tenant needed
curl http://localhost:4000/ready      # {"checks":{"mongo":"up","redis":"up"}}
```

If `/ready` says `mongo: down`, your infrastructure isn't up — run `pnpm docker:dev`.

> **"Port 4000 already in use"?** You have the app _containers_ running from a previous `--profile apps` run. They also want 4000. Stop them with `pnpm docker:dev:down` and start again — or, if you want to test the fully containerized build instead, see §8.

---

## 4. Create a hospital to test against

Nothing is testable until a hospital exists. **There is deliberately no signup endpoint** — creating a hospital is an operator action, so no unauthenticated route can ever create one.

```bash
pnpm --filter @medicore/api provision -- \
     --name "Demo Hospital" --slug demo --plan PLAN_CLINIC \
     --admin-email admin@demo.test --admin-password 'Demo!Passw0rd#2026'
```

This creates the database `hms_demo`, runs its migrations, seeds the system roles, and creates the first administrator. If you omit `--admin-password`, a strong one is generated and **printed once** — copy it, it is not recoverable.

---

## 5. The key idea before you test anything

**The `Host` header picks the hospital.** Every `/api/v1/*` request is resolved to exactly one hospital's database _before any handler runs_, using the hostname. So `Host: demo.paperlesstech.in` means "the demo hospital", and there is no other way to say it — no `tenantId` in the URL, no header you can forge.

That's why every command below sets a `Host` header. `/health` and `/ready` are the exceptions — they must work without a hospital.

---

## 6. Test the whole auth flow (copy-paste)

Paste this whole block into a terminal:

```bash
H='Host: demo.paperlesstech.in'
API=http://localhost:4000/api/v1

# ── login ────────────────────────────────────────────────────────────────
LOGIN=$(curl -s -X POST $API/auth/login -H "$H" -H 'Content-Type: application/json' \
        -d '{"email":"admin@demo.test","password":"123456"}')
echo "$LOGIN"

ACCESS=$(echo "$LOGIN"  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
REFRESH=$(echo "$LOGIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['refreshToken'])")

# ── who am I ─────────────────────────────────────────────────────────────
curl -s $API/auth/me -H "$H" -H "Authorization: Bearer $ACCESS"

# ── my logged-in devices ─────────────────────────────────────────────────
curl -s $API/auth/sessions -H "$H" -H "Authorization: Bearer $ACCESS"

# ── refresh (returns a NEW refresh token — the old one is now spent) ──────
curl -s -X POST $API/auth/refresh -H "$H" -H 'Content-Type: application/json' \
     -d "{\"refreshToken\":\"$REFRESH\"}"

# ── logout, then prove the token is dead ─────────────────────────────────
curl -s -X POST $API/auth/logout -H "$H" -H "Authorization: Bearer $ACCESS" \
     -H 'Content-Type: application/json' -d '{}'
curl -s $API/auth/me -H "$H" -H "Authorization: Bearer $ACCESS"    # → HMS-AUTH-002
```

### The security behaviours worth seeing for yourself

```bash
# Wrong password, unknown email, and a disabled account are INDISTINGUISHABLE.
# Login is not a way to discover who has an account here.
curl -s -X POST $API/auth/login -H "$H" -H 'Content-Type: application/json' \
     -d '{"email":"admin@demo.test","password":"wrong"}'          # → HMS-AUTH-001
curl -s -X POST $API/auth/login -H "$H" -H 'Content-Type: application/json' \
     -d '{"email":"ghost@demo.test","password":"wrong"}'          # → HMS-AUTH-001 (identical)

# An unknown hospital is rejected before credentials are even looked at.
curl -s -X POST $API/auth/login -H 'Host: nosuch.paperlesstech.in' \
     -H 'Content-Type: application/json' \
     -d '{"email":"admin@demo.test","password":"123456"}'   # → HMS-TEN-001

# REFRESH TOKEN THEFT. Rotate once, then replay the old token — the whole
# session family is destroyed, for the thief AND the real user.
NEW=$(curl -s -X POST $API/auth/refresh -H "$H" -H 'Content-Type: application/json' \
      -d "{\"refreshToken\":\"$REFRESH\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['refreshToken'])")
curl -s -X POST $API/auth/refresh -H "$H" -H 'Content-Type: application/json' \
     -d "{\"refreshToken\":\"$REFRESH\"}"     # → HMS-AUTH-003 reuse detected
curl -s -X POST $API/auth/refresh -H "$H" -H 'Content-Type: application/json' \
     -d "{\"refreshToken\":\"$NEW\"}"         # → HMS-AUTH-002, the good token died too
```

### Cross-hospital rejection — the most important test in the system

Provision a second hospital, then try to use the first one's token on it:

```bash
pnpm --filter @medicore/api provision -- --name "Other Hospital" --slug other \
     --admin-email admin@other.test --admin-password 'Other!Passw0rd#2026'

curl -s $API/auth/me -H 'Host: other.paperlesstech.in' -H "Authorization: Bearer $ACCESS"
# → HMS-TEN-003 Tenant mismatch
```

The token's signature is perfectly valid. It is refused because it was minted for `demo`, and the hostname selected `other`'s database. **The host picks the database, the token proves the user, and the two must agree.** Neither alone is enough.

---

## 7. Testing from a browser

Two things make browser testing awkward, and both are by design:

1. **You cannot set a `Host` header from the URL bar.** You must make the hostname real.
2. **There is no login page yet.** The web apps only render a health card today.

To browse the API by hostname, add the hospitals to your hosts file (one-time):

```bash
sudo sh -c 'echo "127.0.0.1 demo.paperlesstech.in other.paperlesstech.in" >> /etc/hosts'
```

Now these work in the browser:

- http://localhost:4000/health — liveness (no hospital needed)
- http://demo.paperlesstech.in:4000/api/v1/auth/me — returns `HMS-AUTH-002` without a token, which is correct
- http://localhost:3000 — the web app (health card)
- http://localhost:3001 — the admin console (health card)

For real request-building in a browser-like tool, import into **Postman / Insomnia / VS Code REST Client**: set the base URL to `http://localhost:4000/api/v1`, add the header `Host: demo.paperlesstech.in` to every request, and put the access token in `Authorization: Bearer …`.

---

## 8. Fully containerized run (optional)

This builds real production images for all four apps and runs everything in Docker. Use it to check the Docker build, not for day-to-day development (no hot reload).

```bash
docker compose -f infra/docker/docker-compose.yml --profile apps up --build
```

Same ports as above. **Do not run this at the same time as `pnpm dev`** — they both want 4000/3000/3001/4100. Stop with `pnpm docker:dev:down`.

---

## 8b. Plans, limits and editions (A2)

A hospital's **edition** decides what it may use and how much. Limits are enforced when you CREATE something — the 11th staff account on a 10-seat Clinic plan is refused with `HMS-PLAN-001`, and nothing is half-created.

```bash
pnpm --filter @medicore/api plan -- --list                          # the edition catalog
pnpm --filter @medicore/api plan -- --slug demo --plan PLAN_CLINIC  # change a hospital's plan
```

Changing a plan is an **operator** action: `plan:manage` is granted to no hospital role, so a customer cannot upgrade itself to Enterprise for free. A hospital admin can _see_ their plan and usage at **/subscription** (amber bar from 80%), but not change it.

A downgrade that would strand people is refused: put 12 staff on a plan and try to drop to Clinic (10 seats) and it tells you to reduce usage first, rather than silently locking two people out.

---

## 8b2. The operator console — creating hospitals (A1)

This is how a hospital gets onto the platform without a developer.

**Bootstrap the first operator** (once — it refuses to run again, because a script that mints super-admins on a live platform is a back door):

```bash
pnpm --filter @medicore/api operator -- \
  --email you@paperlesstech.in --name "Your Name" --password 'super123'
```

**Then open http://admin.localhost:3001** and sign in with those credentials.

You will see every hospital on the platform. Click **+ New hospital**, fill in a name, a slug, an edition and an admin email — and you get back a sign-in URL, an email and a temporary password, shown once. That hospital now has its own database, its own migrations, its own roles and an administrator who can log in immediately. Hand the three lines to the customer.

You can also **re-price** a hospital, **suspend** one (which locks every member of their staff out immediately — it is for non-payment and security incidents, not a pause button), and **issue a fresh administrator** when a customer phones to say they are locked out.

### The security properties worth checking yourself

- **`admin` is a reserved slug.** Try to create a hospital with the slug `admin` and it is refused. The hostname IS the tenant, so a hospital called `admin` would own the console's own address.
- **An operator token does not work on a hospital.** Take the console's token and call `/api/v1/users` on `demo.localhost:4000` → `HMS-AUTH-002`. It carries no tenant claim, so it can never match a hospital.
- **A hospital admin's token does not work on the console.** The mirror: `HMS-AUTH-002`.
- **The hospital can see us.** After creating one, sign in as its admin and open **Activity trail**: the first entries name the operator who provisioned it. When we issue an administrator, that is recorded there too. A customer who cannot see the vendor's actions in their own audit log has no way to detect us misusing them.
- **No PHI.** There is no screen or route in the console that shows patient data, and there never should be.

---

## 8c. The activity trail and tamper evidence (A5)

**In the browser:** sign in and open **Activity trail** (sidebar → Administration). Add a staff member and refresh — you will see four entries for that one click: the account created, the password set, the role assigned, the account activated. Try something you are not allowed to do and the _refusal_ is recorded too.

The trail is **append-only**. There is no edit button, no delete button, and no API route that could make one — the model itself throws on every update and delete operation. A correction is a new entry, never a rewrite.

**Prove it is tamper-evident.** The point of the hash chain is not that we promise the trail is honest; it is that you can check.

```bash
# Seal recent entries into a hash-chained anchor (this is the nightly job)
pnpm --filter @medicore/api audit:chain -- --seal --slug demo

# Recompute every hash and every anchor
pnpm --filter @medicore/api audit:chain -- --verify --slug demo
#  → "audit chain verified — no tampering detected"   (exit 0)
```

Now be the attacker. Edit a sealed entry straight in MongoDB — bypassing the application entirely, which is the only way to do it:

```bash
docker exec $(docker ps -qf name=mongo | head -1) mongosh --quiet --eval '
  db = db.getSiblingDB("hms_demo");
  db.auditLogs.updateOne({seq: 1}, {$set: {actorEmail: "someone.else@demo.test"}});'

pnpm --filter @medicore/api audit:chain -- --verify --slug demo
#  → "AUDIT CHAIN DOES NOT VERIFY — the trail has been altered since it was sealed"
#  → names the exact entry, and exits 1 (so a cron job alerts)
```

Hospital admins can run the same check from the UI — the **Check integrity** button on the Activity trail. Tamper evidence that only the vendor can verify is evidence the customer has to take on trust, which defeats the purpose.

**Honest limits.** This _detects_ tampering; it cannot _prevent_ it. And the anchors currently live in the same database they protect, so a determined attacker with full database access could rewrite entries and re-seal. Shipping the daily anchor root off-box is what closes that, and it is on the list.

> If `--verify` ever reports tampering you did not do, that is a bug in us, not evidence against you — tell us. It happened once during A5 development (a hashing bug, since fixed), and a tamper alarm that cries wolf is worse than no alarm at all.

## 8d. Watching an event travel (the outbox)

Every staff account created, role granted, and plan changed publishes a domain event — written to the database **in the same transaction as the change itself**, so a crash can never leave you with a notification about something that did not happen (or a thing that happened with nobody notified).

Watch it end to end. With `pnpm dev` running, create a staff member in the UI, then look at the **workers** output:

```
domain event received (no consumer registered yet — acknowledged)
  event: identity.user.created   eventId: fcc6216e-…   traceId: ecdc2037-…
```

That `traceId` is the same one on the HTTP request that created the account — the whole path is traceable from click to consumer. There is no real consumer yet (that arrives with notifications, A6); the worker acknowledges and logs, which is what keeps the pipeline honest instead of theoretical.

---

## 9. Automated tests

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # full quality gate
pnpm boundaries                                          # module boundary rules
pnpm --filter @medicore/api test:int                     # 658 integration tests (isolation, auth, RBAC matrix, encounters, orders, billing, prescriptions, pharmacy, admissions)
```

`test:int` needs `pnpm docker:dev` running. **658 tests across 14 suites** against a **real** MongoDB and Redis, and it **fails rather than skips** if either is missing — a silently skipped isolation suite looks exactly like a passing one.

All gates, as of **2026-07-16**: integration **658 passing**, typecheck 17/17, lint 17/17, build 11/11, module boundaries **0 violations** across 665 modules, **117 API routes** — every one carrying a permission that a test asserts, because the route nobody thought about is the one that answers everybody.

**Known flake:** seen twice (`1 failed | 437 passed`, then `1 failed | 601 passed`), green on every re-run, and **the name was not captured either time** — which is the actual failure. Suspected the Mailhog timing suite under load, but that has never been confirmed. Recorded as debt in `PROJECT_MEMORY` §5. Next occurrence: pipe the full output to a file BEFORE filtering it. **It must not be "fixed" by deleting the assertion.**

#### 2026-08-17 — the names, at last, and what they rule out

The instruction above was followed and the output kept. **Four consecutive runs, four disjoint sets
of failures, zero overlap in test names:**

| Run                      | Result                    | Failed                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| full `test:int`          | `1 failed \| 1734 passed` | `mar > lets a doctor read the round…` (`admitToWard` got **404**, expected 201) · `branchIsolation.int.test.ts:180` **`beforeAll` hook timeout**                                                                                         |
| full `test:int`          | `4 failed \| 1834 passed` | `mar > shows a charted dose as given on the very next read` · `prescriptions > SIGNING … does not charge the patient a paisa` · `rbac > DOCTOR may NOT GET /billing/pending` · `rbac > RECEPTIONIST may NOT GET /reports/patient-visits` |
| `rbac.int.test.ts` alone | `1 failed \| 1225 passed` | `rbac > PHARMACIST may NOT POST /appointments/:id/reschedule`                                                                                                                                                                            |
| `rbac.int.test.ts` alone | `1 failed \| 1225 passed` | `rbac > RECEPTIONIST may NOT DELETE /users/:id/roles/:roleCode`                                                                                                                                                                          |

**No failure was ever a wrong answer.** Not one assertion about a permission, a price or a dose has
failed. The RBAC rows are the most alarming to read in a log — a line saying
`DOCTOR may NOT GET /api/v1/billing/pending — FAIL` looks exactly like a permission leak — and they
are the least meaningful. Anyone triaging this must read the failure body before reacting to the
test name.

**What it ruled out.** The tracker's standing advice is _"check Docker memory first"_, and it was
checked **during** a failing run: `medicore-hms-mongo-1` at **3.4 GiB of 7.75 GiB**, **no HMS
container exited 137**. Not the OOM-kill scenario that had been the leading explanation. Not
accumulated state either — 14 databases, 5 of them test. Not a code regression: the session that
observed it changed **only** files under `AI_Workflow/`.

#### A clean run that looked like an answer, and was not

Docker Desktop crashed a few hours after the runs above. When it came back **only HMS's four
containers were running**, so the host went from ~30 containers to 4 with no change to this
repository, and the next run was **1838/1838** with `pnpm gate` exiting 0 end to end.

That was written up here as "the natural experiment that settled it: contention from other
projects". **It did not survive the next run.** With the host still at four containers, the very
next gate failed 4 of 1842. The retraction is kept rather than edited away, because the mistake is
the instructive part: a single green run after changing one big variable is exactly what a
wandering flake looks like when you want it to be solved. Mailhog was investigated and rejected on
the same evidence — only `orders` and `notifications` import `mailTestEnv`, no failure was ever in
either, and a shared-inbox race produces a wrong count, not a 404.

#### 2026-08-17 — SOLVED: the request was answered by a different process on this machine

The tell was the thing that had looked like a logging bug. `requestLog` is registered **second in
the chain, before helmet and cors, precisely so every request is logged** — yet the failing
requests had **no log line at all**. That was not a lost line. It was the literal truth: the
request never arrived here.

Proven by tracing below Express, at `node:http`, writing to a file of its own so nothing depended
on vitest's stdout capture. Three instrumented full runs, five anomalies, and every one of them
resolved the same way:

| Run | Symptom the suite reported                                       | What the transport showed                              |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | `billing` — `Error: socket hang up`                              | connected to :49671, **no `request` event ever fired** |
| 2   | `rbac` — PHARMACIST reached `/reports/discharge-outcomes`: 404   | answered **without an `x-request-id`**                 |
| 3   | `vitals` ×2 — 404 on `POST /encounters/:id/vitals`               | answered **without an `x-request-id`**                 |
| 3   | `branchIsolation` — 401 on a request that had just authenticated | answered **without an `x-request-id`**                 |

`requestId` is the FIRST middleware, so a response with no `x-request-id` did not come from this
application. `lsof`, run at the moment of the anomaly, named who it did come from:

```
Code Helper  738   127.0.0.1:49183 (LISTEN)     Code Helper 2007  127.0.0.1:53579 (LISTEN)
Code Helper  1559  127.0.0.1:49435 (LISTEN)     java        2393  127.0.0.1:49671 (LISTEN)
Code Helper  1991  127.0.0.1:49715 (LISTEN)
node        14992  *:49183 (LISTEN)   ← ours, on the same port
```

**Five foreign listeners, and every anomaly across all three runs landed on one of those five
ports.** The mechanism, end to end:

1. `request(app)` is **one HTTP server per request** — supertest wraps the app in a fresh
   `http.createServer(app)` and calls `app.listen(0)` every time. A full run makes ~4,100 requests
   and burns ~8,200 ephemeral ports; the macOS ephemeral range is 16,384 wide (49152–65535). One
   run sweeps most of it.
2. `listen(0)` with no host binds the **wildcard** address, and Node sets `SO_REUSEADDR`. On
   BSD/macOS that bind **succeeds** on a port another process already holds on a specific address —
   no `EADDRINUSE`, no warning.
3. supertest then connects to `127.0.0.1:<port>`, and the kernel routes to the **most specific**
   listener: the other process.
4. It answers. Plausibly — some of those editor helpers are themselves Express, so what comes back
   is a real Express 404 (`x-powered-by: Express`) for a route it has never heard of. The JVM
   accepted the connection and reset it: "socket hang up".

Everything the flake did follows from that. Green in isolation, because a single suite makes ~120
requests and rarely lands on one of the five. Wandering, because it is positional in the port
sequence and has nothing to do with any suite's code. Never a wrong clinical answer, because the
application never processed the request. And invisible in the logs, for the same reason.

**The fix** is one listening server per suite, bound to `127.0.0.1` — `listening()` in
`src/test/appServer.ts`. The kernel will not hand a `127.0.0.1:0` bind a port already in LISTEN on
127.0.0.1, so the collision goes from rare to impossible, and the ~4,100 binds per run become 21.
`src/test/noWildcardBinds.setup.ts` makes a wildcard ephemeral bind throw, so the default cannot be
reintroduced quietly; `src/testServerBinding.test.ts` pins both the guard and the platform
behaviour it defends against.

Verified: full `pnpm gate` green end to end, integration **1842/1842**, with the five foreign
listeners still up on the machine that had been failing about once a run.

**Do not raise `testTimeout`/`hookTimeout` if something like this returns.** A test that needs
longer under load is evidence; a test that is allowed longer is silence. And if a failing request
has no line in the request log, believe the log: it did not arrive.

---

### `Cannot find module './963.js'` — or any Webpack chunk that does not exist

**This should no longer happen.** It was caused by `next dev` and `next build` both writing to `apps/web/.next`: run a build while the dev server was up and the production output replaced the chunks the dev server had open, so the browser asked for a file nobody ever wrote.

Dev now writes to `.next-dev` and builds write to `.next`, so the two cannot collide — you can run `pnpm build` in another terminal while `pnpm dev` is running and nothing breaks. (Verified by doing exactly that.)

If you ever do see it, the cache is stale for some other reason and this always fixes it:

```bash
pnpm clean     # removes .next, .next-dev, dist and turbo caches
pnpm dev
```

## 10. When something goes wrong

| Symptom                                          | Cause and fix                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| API exits immediately at startup                 | `API_JWT_SECRET` or `API_ENCRYPTION_KEY` missing from `apps/api/.env`. It fails fast on purpose — see §2.            |
| `EADDRINUSE :4000`                               | App containers from a `--profile apps` run are still up. `pnpm docker:dev:down`, then `pnpm docker:dev && pnpm dev`. |
| `/ready` shows `mongo: down`                     | Infrastructure isn't running. `pnpm docker:dev`.                                                                     |
| `HMS-TEN-001 Organization not found`             | The `Host` header doesn't match a provisioned hospital. Check the slug, and that you provisioned it (§4).            |
| `HMS-AUTH-002` on every request                  | Missing/expired/logged-out access token. Access tokens live 15 minutes — log in again or use `/auth/refresh`.        |
| `HMS-AUTH-001` with a password you know is right | You hit the lockout: 5 failed attempts locks the account for 15 minutes. Wait it out, or re-provision.               |
| `getaddrinfo ENOTFOUND mongodb`                  | A Mongo URI is missing `directConnection=true`. Never remove it in dev — see `AI_Workflow/PROJECT_MEMORY.md` §8.     |

---

## 11. Validation strategy — automated, not manual (2026-08-18)

**The manual validation campaign was deliberately replaced by automated engineering validation.**
Browser-dependent scenarios are covered by Playwright where a browser genuinely adds coverage;
security, clinical, business and persistence scenarios are covered at the lowest layer that can
prove them. `MANUAL_VALIDATION_RUNBOOK.md` remains the authority for **what each scenario means** —
it is what the tests were written from — but it is no longer a checklist anybody works through.

### What the audit found

The runbook's 232 IDs were audited against the existing suites before a line of test code was
written. The headline is that **the API was already far better covered than the runbook implies**:

| Manual scenario                          | Invariant                                     | Existing coverage                                                                                                       | Browser needed?      | Action                                                           |
| ---------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------- |
| **BR-10** cross-branch report file       | The bytes stop at the branch                  | `branchIsolation.int.test.ts` §22 — real upload, list check, exploit by id, All-branches mode, and the positive control | No                   | **Strengthened** — also asserts the refusal carries no PDF bytes |
| **BR-11** cross-branch appointment write | A foreign site cannot drive the state machine | §23 — all three transitions, the positive control, **and the re-read** the runbook's "trap" demands                     | No                   | **Keep** — already stronger than the manual row                  |
| **BR-07** branch-confined user           | A bound user cannot exceed their binding      | §2, plus confined NURSEs in `mar` and `nursing`                                                                         | No                   | **Keep**                                                         |
| **BR-12** wallet is hospital-wide        | A deliberate non-boundary                     | §24, pinned in that direction on purpose                                                                                | No                   | **Keep**                                                         |
| **TEN-01** tenant isolation              | Separate databases (ADR-0005)                 | `tenancy.int.test.ts`, plus cross-tenant refusals in `mar`                                                              | No                   | **Keep**                                                         |
| **DRIFT-01…12** schema guards            | Refuse when the rule cannot be enforced       | Five capabilities × refusal + code + `Retry-After` + **row count** + proportionality + cross-tenant + recovery          | No                   | **Keep**                                                         |
| **JR-01…22** clinical journey            | The state machine                             | `encounters`, `admissions`, `orders`, `prescriptions`, `billing`                                                        | Partly               | **Keep** API; Playwright for the browser seams                   |
| **WEB-01…24**                            | Mixed                                         | jsdom suites cover rendering with a mocked `fetch`                                                                      | **Yes, for several** | **Playwright**                                                   |
| Mobile M2/M3                             | Mixed                                         | 1647 mobile tests + the client contract suite                                                                           | Device-only for some | **Keep** + documented limits                                     |

**Two "gaps" in the first pass were artifacts of a keyword search, not real.** Proportionality
(DRIFT-02), cross-tenant independence (DRIFT-08) and the DRIFT-05 database-state check all already
existed under names the search missed — `"does not block vitals, nursing notes, or reads while
charting is refused"`, `"refuses only the tenant whose index is missing"`, `"leaves the outpatient
encounter untouched when it refuses"`. Duplicates written before that was noticed were **removed**:
the existing tests are stronger, because they also cover reads and the other tenant actually
writes. Recorded because "add a test" is the cheap answer and "the test is already there under a
better name" is the correct one.

### What was genuinely missing: the browser

**Every one of the fifteen web suites runs in jsdom with `fetch` mocked.** They prove a component
renders what it is handed; none proves the assembled application, talking to a real API over real
cookies, hands it the right thing. That is the whole of what the manual campaign was really for,
and it is now `e2e/`.

```bash
pnpm test:e2e        # the browser suite (starts the stack if it is not already up)
pnpm gate            # everything else — now also typechecks e2e/
pnpm gate:full       # both, in order. This is the release gate.
```

**Ten tests, deliberately not a mirror of the checklist.** Each one is a thing only a browser can
see:

| Spec                     | What it proves                                                                                                                                                           | What it would catch                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth.spec.ts`           | Sign-in lands in a named hospital with navigation; an unknown host blames the **address**; a wrong password keeps the email                                              | A permission→navigation break; a whole hospital resetting passwords over a DNS error                                                       |
| `branchSwitch.spec.ts`   | Switching sites repaints the ward, **no bed from the previous site survives**, and the choice outlives a reload                                                          | The original defect this design exists to prevent — a header naming one site over another site's patients                                  |
| `clinicalSafety.spec.ts` | A doctor's round renders with every dose row **inert**, a nurse's does not; every ward row is named and the chart carries a UHID                                         | A doctor able to chart a dose from the UI (P1); web defect **D-1** returning — `Patient: —` at the moment of administration                |
| `staffDirectory.spec.ts` | The directory narrows to the active site, says which scope it counted, and shows each person's branch binding                                                            | The staff branch scope silently going away — nothing in the tenantScope plugin holds it up                                                 |
| `pageHealth.spec.ts`     | The eleven back-office pages, and the patient chart, load against the real API and are **refused nothing they did not expect**                                           | A page being told "no" and drawing a zero. **It found two live defects doing exactly that** — see below                                    |
| `reportsExport.spec.ts`  | Export CSV hands over a file named for the period, with rows under its header                                                                                            | The Blob → object URL → anchor → revoke path breaking: a button that spins, succeeds, and delivers nothing                                 |
| `labWorklist.spec.ts`    | The bench: the ordered test reaches the queue named and UHID'd, the payment badge agrees with the server, the matching control is offered, and a branch switch clears it | A worklist that loads empty because the page sends no branch; a row that cannot name its patient; a badge that holds work already paid for |

`workers: 1`, `retries: 0`, no `waitForTimeout` anywhere, and site names are **discovered from the
switcher** rather than hardcoded, because `seed:validation` names the second site differently when
it adopts an existing branch.

### What the page sweep found: two pages showing a refusal as emptiness

The eleven pages this document previously listed as having no coverage at any layer — `/mrd`,
`/mortuary`, `/theatres`, `/ambulance`, `/assets`, `/packages`, `/tariff`, `/feedback`, `/audit`,
`/subscription`, `/reports` — now have one test each. (An earlier revision of that list also named
`/insurance`; **there is no such page** — insurance is a tab on the patient chart.)

The sweep is deliberately not eleven CRUD flows. It asserts something narrower and much harder to
fake: **every request the page made came back, and none was refused unless the refusal is declared
in the spec with its reason.** Writing it turned up two live defects of a single shape:

| Where         | The request                       | What the user saw                                                         |
| ------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `/feedback`   | `GET /users?limit=200` → **400**  | Every ticket's assignee shown as an unresolved id. Never a name. Ever.    |
| Patient chart | `GET /orders?limit=200` → **400** | **"Tests 0"** on a patient holding three orders — a short clinical record |

The cap on every list is **100**. Both callers asked for 200, both were refused with
`HMS-VAL-001`, and both pages had a `catch` written for the _permission_ case — `.catch(() =>
setStaff([]))` and `soft(…)` — which folded a validation error into ordinary emptiness.

Neither is visible from below. The API is correct and its tests pass; the jsdom suites mock `fetch`
and never send the bad request. Only a browser against a real server can watch a page be told "no"
and draw a zero. Both call sites now request 100, and reverting either turns the sweep red.

The one **declared** refusal is `/mortuary`: `module.support.mortuary` is not in `PLAN_HOSPITAL`,
so the API answers `HMS-PLAN-002` and the page says "Feature not in your edition" with a reference.
That is the entitlement gate working, and it is swept precisely so a plan refusal keeps reading as
an explanation rather than as a blank register.

### A missing seed is now a failure, not a pass

`preflight.setup.ts` is a **setup project every other project depends on**. It checks over HTTP, in
about a second, that the hospital `seed:validation` builds is actually present: the four demo
accounts can sign in, the nurse can work in two open sites, **both sites have occupied beds and
their bed codes are disjoint**, doses are scheduled today, and the directory has people. Each
failure names `pnpm docker:dev && pnpm seed:migrate && pnpm seed:validation`.

The third check is the one that matters. `branchSwitch.spec.ts` asserts that no bed from site A
survives a switch to site B — and on a hospital whose second site is empty, that compares against
nothing and **passes for free**. The specs used to guard this with `test.skip(sites.length < 2)`,
which reports a missing environment as a PASS: the gate would have said 10/10 having never
exercised cross-branch display of PHI in a browser. Every skip has been replaced by a hard
assertion, and the environment is now proved once, out loud, before the browser opens.

### Falsification — these tests were proven able to fail

| Protection removed                                             | Test result                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Branch scope on the single-report read (**reintroducing D10**) | 🔴 _"a Chennai administrator downloaded a Hyderabad report (status 200)"_                                    |
| Branch scope on the appointment read (**reintroducing D9**)    | 🔴 all four, including _"leaves the Hyderabad appointment untouched"_ — the half the runbook's trap is about |
| `BranchScope`'s subtree key                                    | 🔴 _"beds from Main Branch survived a switch to apollo golconda"_                                            |
| The staff-directory branch exclusion                           | 🔴 2 of 4 integration tests                                                                                  |
| The staff count reading the server total                       | 🔴 _"expected '100 people at Main Branch' to match /Showing 100 of 137/"_                                    |
| The loopback test-server guard (T3)                            | 🔴 binds `::`                                                                                                |
| The `limit: 100` fix on `/feedback` and the patient chart      | 🔴 _"400 HMS-VAL-001 /api/v1/users?limit=200"_, _"…/orders?…&limit=200"_                                     |
| The UHID beside the name on a medication-round row (FR-02)     | 🔴 _"a dose row carried no UHID beside the patient's name"_                                                  |
| `hostIsUnknown` on the branding call (**WEB-02**)              | 🔴 the address is never blamed before a password is submitted                                                |
| The preflight's disjoint-bed check, pointed at one site twice  | 🔴 _"… use the same bed codes … indistinguishable from a legitimate one"_                                    |
| The preflight, run at a tenant without the demo accounts       | 🔴 _"these demo accounts cannot sign in at http://district.localhost:4000 — run `pnpm …`"_                   |

Production code was restored after each, and the gate re-run green.

### Two disagreements between the runbook and the implementation — now decided

Both were found while automating and left open as PRODUCT DECISION candidates. They have since
been investigated against the implementation, ADR-0005, §9 of the runbook and the existing tests,
and **decided in opposite directions** — which is the point: neither "the doc wins" nor "the code
wins" is a rule.

#### WEB-02 — the runbook was right. **Product changed.**

The row says: browse a slug that does not exist, and be told _"This address does not belong to any
hospital"_. The implementation only said it **on submit**, mapped from the login response.

What settled it was finding that the app **already had the answer and discarded it**.
`BrandingProvider` calls the public `GET /site` on every page load, and on an unknown host that
returns exactly `HMS-TEN-001` — the API's code for "this hostname matches no tenant in the
registry", distinct from suspended (`002`), licence lapsed (`005`) and registry unreachable
(`004`). The provider caught it and set `loaded: true`.

So the only way to learn you were at the wrong address was **to type your real password into a host
that is not your hospital's**. The hostname IS the tenant (ADR-0005): a wrong address is not a typo
in a form, it is a different machine. Withholding an answer the app already holds, until after the
credential has been sent, is the wrong order.

The fix publishes one flag, `hostIsUnknown`, and is deliberately narrow — **`HMS-TEN-001` only**. A
network blip or a restarting API must never tell a working hospital that it does not exist, and
`e2e/auth.spec.ts` asserts that negative directly ("does not accuse a real hospital's address of
being wrong") alongside the positive.

#### WEB-04 — the runbook was over-specified. **Product unchanged; the row amended.**

The row says "Name + UHID on every row" of `/ward`. The ward puts the name on the row and the UHID
on the chart the row opens.

The row points at **§9**, and §9 is explicit about where the five rights apply: _"every
administering surface … the confirmation screen a nurse reads at the moment of giving."_ **A ward
list is not one** — no drug can be given from it. It is a navigation rail beside a patient panel,
and the panel carries both identifiers. The surfaces that ARE administering already satisfy the
rule on the row itself: `/medication-round` renders `patientName` and `uhid` together, resolved
server-side, and passes both into the confirmation.

Changing the ward row would have been changing the product to satisfy a document that was stricter
than its own safety rule. Instead the runbook row now says where the requirement applies — and the
requirement is now **tested where it matters**, which it previously was not:
`clinicalSafety.spec.ts` asserts every dose row on the round carries a name AND a UHID. That is
FR-02's actual claim, and until now no test made it in a browser.

### Not automatable — stated plainly, not quietly dropped

These were **never** manually executed either, so nothing is being lost. They are recorded so a
green suite is not mistaken for coverage of them:

- **Biometrics** (M2-35…M2-47) — no enrolled fingerprint or Face ID exists in CI or in a
  simulator. The lock's _logic_ is covered by the mobile suite; the **OS prompt** is not.
- **A real radio** — cellular handover mid-save (NET-08). A mocked failure is a decision; a lost
  packet is an accident, and only the second one tests reconciliation honestly.
- **App-switcher snapshots**, sunlight legibility, and layout at the largest OS text size — these
  need eyes and a device.
- **Two physical devices in two hands** (MAR-02). The concurrency invariant _is_ proven — two real
  HTTP clients race the same dose in `mar.int.test.ts` — but two nurses reaching for the same
  drug is a human scenario, not a client one.
- **Writes on the back-office registers.** `e2e/pageHealth.spec.ts` loads all eleven of them
  (see below) but creates nothing: driving a theatre booking or an ambulance dispatch through a
  browser would leave rows in the shared seeded hospital and make the suite's second run differ
  from its first. Those writes are proven at the integration layer against a real Mongo.
- **The activity trail's CSV export.** `/reports` proves the Blob-and-anchor download path;
  `/audit` uses the same mechanism, and a second browser test of it would re-prove the same
  plumbing at the cost of a minute per run. Its rows and columns are the API's, and the API's
  tests own them.

**Status vocabulary.** Automated coverage is recorded as `AUTOMATED — PROVEN`,
`AUTOMATED — STRENGTHENED`, `AUTOMATED — PLAYWRIGHT`, or
`NOT AUTOMATABLE — DOCUMENTED LIMITATION`. **"Manual PASS" is never used**, because no human has
executed any row.

---

## 12. What you cannot test yet (updated 2026-07-16)

Not bugs — **not built**, each for a stated reason. The reasons are recorded in
`AI_Workflow/PROJECT_MEMORY.md` §4 and §5. Do not demo anything in this list.

> Everything this section used to say was **out of date and wrong**: patients, appointments,
> encounters, orders, billing, prescriptions and pharmacy all ship today, and `authorize`
> enforces all three layers (entitlement → permission → row scope). §1d is the current truth.

**Deliberately absent, and dangerous to pretend otherwise:**

- **There is NO BED INVENTORY.** No wards, no rooms, no occupancy, no "which beds are free" —
  the **Bed board** in the nav is still greyed out as `soon`. `/ward` derives its list from where
  patients ARE, and **nothing stops two patients being recorded in bed A-12**. A half-built
  occupancy map is worse than none: one that is only sometimes true is one people stop checking,
  and then the wall chart stops being maintained too.
- **`lama` (left against medical advice), `absconded` and `deceased` are recorded as an ordinary
  discharge.** This is a **lie in the record** — three clinically, legally and statutorily
  different events, all saying "discharged". Nobody should demo IPD to a real hospital until this
  is fixed (STATE_MACHINE_CATALOG §2).
- **Nothing holds a patient until the bill is settled** (`discharge_initiated`). We discharge and
  bill in one act.

- **Pharmacy stock.** No batches, no expiry, no purchasing. The counter **will let you dispense a
  drug the shelf does not have.** A half-built stock number is worse than none — people believe
  it, and a number that is only sometimes decremented is trusted right up until it matters.
- **Allergy, interaction and duplicate-therapy checking — now BUILT (2026-07-16).** See §1d "Allergy
  safety" for how to test it. The remaining gap is coverage, not existence: it is a curated net over
  the 15 demo drugs, not a formulary — no renal/hepatic dosing, weight bands, pregnancy category or
  dose ceilings. **Do not present it to a hospital as a drug database.** Widening the drug list without
  widening the allergen/interaction data behind it would recreate exactly the "half-implemented check
  is worse than none" trap this was careful to avoid.
- **Specimen tracking** — the tube's own life (collected → in transit → haemolysed → recollect).
  Orders carry lab work today without it, which is exactly what a hospital using an outside lab
  needs.

**Not started:**

- **Staff chat** (WhatsApp-style, wanted), the **mobile app**, insurance / claims / pre-auth /
  refunds, the licence-expiry gate, OpenAPI docs (111 routes), the universal work queue
  (ADR-0014), the `patients.merged` consumer.
- **Forgot/reset password.** Postponed until the notification channel is wired to a real
  provider — a reset flow that cannot deliver a reset is worse than none. (An admin can reset a
  password from **Staff** today.)
- **A role editor.** You can assign an existing role; you cannot yet build a new one from a
  permission matrix.

---

## 13. Manual Verification — enhancement tracks (2026-07-16)

Short, hands-on checks for the admin/clinical enhancements. Log in at `sunrise.localhost:3000`; every dev account is `123456` (the demo admin `admin@sunrise.test` is now `123456` too — a seed bug that left it on the provisioning password is fixed).

### A1 · Roles & permissions guide (admin)

- **Preconditions:** logged in as `admin@sunrise.test`.
- **Steps:** open **Roles & permissions** in the left nav.
- **Expected:**
  - A **Your plan** card at the top (plan name + staff-login count, e.g. `9 / 250`).
  - A **"Which login do I need?"** table mapping a job to a role — e.g. "See a doctor's appointments and consult patients → Doctor", "Run blood tests and enter diagnoses → Lab Technician".
  - One card per role with a plain-language summary, a green **"When to create this login"** note, a **What they do** list, and the **screens it opens**.
- **Edge cases:** log in as a non-admin (e.g. `drrao@sunrise.test`) and open the same URL — you should get "You do not have permission to manage roles", not a blank page or a crash.

### A2 · Staff management (admin)

- **Preconditions:** logged in as `admin@sunrise.test`. Open **Staff**.
- **Steps & expected:**
  - The list is a **professional table**: Name + email, Role, Department / specialty, Phone, Status, and per-row **View · Edit · Reset password · Disable** actions. Your own admin row has no Disable (you cannot lock yourself out).
  - **Filter** by All / Active / Disabled, and search by name or email.
  - **Add staff → pick a role.** The form ADAPTS: choose **Doctor** and you get Specialty, Qualification and Registration/licence fields; choose **Cashier** and those disappear. Fill some fields, create — a **temporary password shows once**.
  - **Edit** a member: the form pre-fills; change the department/specialty and save; the table reflects it. (Email is read-only — it is the login.)
  - **View** shows the full profile read-only, including MFA state and last sign-in.
  - **Disable** a login (confirm the prompt) → status flips to `disabled` and their sessions end immediately; **Enable** restores it.
  - **Reset password** issues a new temporary password (shown once) and ends their sessions.
- **Edge cases:** every professional field is optional — create a doctor with only name/email/role and it still saves. A non-admin has no Add/Edit/Disable actions.

### B1 · Multi-select order pad (doctor)

- **Preconditions:** logged in as `drrao@sunrise.test`; a patient called in (in progress) on **My patients**.
- **Steps & expected:**
  - In the **Order** card, tap several tests across Blood & lab and X-ray — each toggles a tick and highlights; tap again to deselect.
  - Set one **priority** for the batch.
  - Press **Send N for tests** → all selected go to the worklist at once; the notice says how many were sent (and how many were already ordered).
- **Edge cases:** the button is disabled with nothing selected; sending twice does not double-order (each carries an idempotency key).

### B2 · Lab report upload & the doctor's report view

- **Preconditions:** a test has been ordered for a patient (do B1 first). Log in as `labtech@sunrise.test` → **Worklist**.
- **Steps & expected:**
  - Each order now has an **Upload report** button. Pick a PDF or image → it uploads with **no verify/approve step** and the notice confirms the ordering doctor can see it.
  - Log in as `drrao@sunrise.test` → **My patients**, select that patient. The **Reports** card lists the report, **grouped by appointment date, then by category** (Blood & lab / X-ray & imaging).
  - Press **View** → the file opens in a new tab (PDF renders, image shows).
  - Reports from **previous visits** appear too — the list is the patient's whole history, not just today's visit.
- **Edge cases:** only PDF/image types are accepted; a file over 10 MB is refused with a clear message; a lab technician cannot open the patient report list (no `emr:read`) — that is the doctor's/clinical view.

## 13 · Track C — Pharmacy medicine master & stock

The pharmacist runs the shelf: what the hospital stocks, what is left of each, and the ledger
behind every number. Stock is **received**, **adjusted**, or **decremented by a dispense** — never
typed in — so each figure has a history an auditor can read. Gated on the `module.pharmacy.full`
edition flag and the `pharmacy:stock` permission (the PHARMACIST holds both).

> Preconditions for every block: API and web dev servers running, migrations applied
> (`pnpm --filter @medicore/api migrate -- --all` — brings in `0019-medicine-master`). Sign in as
> `pharmacy@sunrise.test` (PHARMACIST) unless a step says otherwise. All dev passwords are `123456`.

### C1 · Maintain the medicine master

- **Preconditions:** signed in as the pharmacist. Open **Medicine master** in the left nav.
- **Steps & expected:**
  - Press **Add medicine.** Enter a code (e.g. `PARA_500`), brand name, manufacturer, generic/combination,
    form, strength, tablets-per-strip, strips-per-pack and a reorder level. Save → it appears in the table.
  - The table is professional: Medicine (brand + generic), Code, Form / strength, Pack (`units × strips`),
    Stock, Status, and per-row **Receive · Adjust · History · Edit** actions.
  - **Edit** a medicine — the code field is **frozen** (it is the key a dispense matches on); change the
    reorder level or details and save; the row reflects it.
  - **Search** by name, code or generic narrows the list live.
- **Edge cases:** re-using an existing code is refused with "that medicine code is already in the master"
  (409). A non-pharmacist has no **Medicine master** nav entry and the routes 403.

### C2 · Receive and adjust stock (the ledger)

- **Preconditions:** at least one medicine exists (C1).
- **Steps & expected:**
  - **Receive** → enter a quantity (optionally batch no. and expiry). Save → the **Stock** column rises by
    exactly that amount and the status moves toward **In stock**.
  - **Adjust** → enter a signed change (e.g. `-6`) and a reason (e.g. "breakage"). Save → stock falls by 6.
  - **History** → the movement ledger opens: newest first, each row showing type (receipt / adjustment /
    dispense), the signed change (green in, red out), the running balance after, and the note/batch.
  - The summary strip at the top counts anything **to reconcile / out of stock / running low**, and the
    **Low stock only** toggle filters the table to those at or below their reorder level.
- **Edge cases:** a receipt of zero or a negative number is refused; an adjustment of zero is refused; a
  reason is required on an adjustment. Stock is allowed to go **negative** — it shows as **Reconcile**
  rather than being clamped, because a negative balance is a real fact (more went out than was booked in).

### C3 · A dispense decrements the shelf — automatically, exactly once

This is the load-bearing link: the pharmacy publishes `medication.dispensed` when drugs cross the
counter, and the medicine module **consumes** that event to take them off the shelf — the same way
billing consumes it to charge. The pharmacy never calls the stock system, so a stock fault can never
block a patient's medicine.

- **Preconditions:** a medicine in the master whose **code matches a prescribable drug** (e.g. add a
  medicine with the same code the doctor's drug list uses), stocked via a receipt in C2. Note its stock.
- **Steps & expected:**
  - As a doctor, prescribe and **sign** that drug for a called-in patient (§ prescriptions flow).
  - As the pharmacist, open **Pharmacy** and **dispense** the prescription (hand over, say, 6 units).
  - Back in **Medicine master → History** for that medicine: a new **dispense** row appears, `−6`, with the
    new balance; the **Stock** column has dropped by 6.
- **Edge cases:**
  - A dispensed drug that is **not** in the master produces **no** movement and **no** error — the master is
    the set of drugs the hospital tracks stock for, and dispensing an untracked drug is legitimate.
  - **Idempotency:** the dispense event is delivered at-least-once; a redelivery does **not** double-decrement
    (the ledger carries a unique `dispenseId + code` key). A dispense with the same drug on two lines
    (e.g. QID + SOS) records **one** movement for the summed quantity.

## 14 · Track D — Tariff manager, per-doctor consultation fee, activity-trail filters

> Preconditions for every block: API and web dev servers running, migrations + permission sync
> applied (`pnpm --filter @medicore/api migrate -- --all` — adds the `tariff:manage` permission).
> Sign in as `admin@sunrise.test` unless a step says otherwise. All dev passwords are `123456`.

### D1 · Service tariff manager (admin)

- **Preconditions:** signed in as the admin. Open **Service tariff** under Administration.
- **Steps & expected:**
  - The table lists every priced service — consultations, lab, radiology, procedures — with **Code**,
    **Category**, **Price** (₹) and **Active/Retired** status. Filter by category, search by name/code.
  - **Add service** → enter a code (e.g. `LAB_LFT`), name, category, and a rupee price. Save → it
    appears. The price you set is what a patient is billed when that code is ordered.
  - **Edit** a service — the **code and category are frozen** (orders match on the code); change the
    **name or price** and save; the row updates.
  - **Retire** an active service → it greys out and status flips to **Retired**; the doctor's order pad
    no longer offers it, but past charges keep their price. **Restore** brings it back.
- **Edge cases:** a duplicate code is refused with "that service code is already in the tariff" (409);
  a price of 0 is valid (a government hospital's whole tariff is zeros); a non-admin has no **Service
  tariff** nav entry and the routes 403.

### D2 · Per-doctor consultation fee

The consultation charged when a patient starts a visit can be the **doctor's own rate**, not just the
hospital's flat `CONSULT_GEN` tariff. The line stays a consultation; only its price changes.

- **Preconditions:** admin on the **Staff** screen; a doctor account (e.g. Dr Rao).
- **Steps & expected:**
  - **Edit** the doctor. Because the role is a specialist role, the form shows a **Consultation fee (₹)**
    field. Set it (e.g. `800`) and save. **View** the doctor → the fee shows under the profile.
  - As reception, register a patient and **start an encounter with that doctor**. Open the patient's
    **bill**: the consultation line is charged at **₹800**, the doctor's rate — not the hospital default.
  - Edit a _different_ doctor and leave the fee **blank**; a visit with them charges the hospital's
    `CONSULT_GEN` tariff unchanged.
- **Edge cases:** on a **government** hospital (`gov.localhost`) the zero-tariff policy still flattens the
  consultation to **₹0**, whatever the doctor's fee — free care is a billing mode, not a per-doctor
  choice. A doctor who is deleted or unreadable falls back to the tariff rather than failing the visit.

### D3 · Activity-trail filters (reduce the load)

- **Preconditions:** admin on **Activity trail**.
- **Steps & expected:**
  - The category pills still work. Below them: a **From / To date range** and a **Refusals only** toggle.
  - Pick a date window → the list narrows to entries in those days (inclusive of the whole "To" day).
  - Press **Refusals only** → only failed/denied events show (the ones that reveal an attack or a
    misconfigured login). Combine it with a category and a date window to zero in.
  - **Clear filters** appears once anything is set and resets everything to the first page.
  - **Export CSV** honours the SAME filters — the downloaded file matches what is on screen.
- **Edge cases:** every filter change returns to page 1; an empty window shows "Nothing recorded…" rather
  than an error; the integrity check and CSV export remain `audit:*`-gated (a viewer without export sees
  no CSV button).

## 15 · Reports — the audit/register suite

The month-wise, drug-wise, doctor-wise registers an auditor asks for, all under **Reports**
(Administration nav, `report:view` — the admin holds it). Each takes the same period and each
exports to CSV.

> Preconditions: API + web dev servers running, migrations + permission sync applied
> (`pnpm --filter @medicore/api migrate -- --all` — adds `report:view`). Sign in as
> `admin@sunrise.test`. Pick a period at the top; the "To" day is included in full (the request
> uses a half-open range that ends at the start of the next day). All dev passwords are `123456`.

### R1 · Pharmacy stock register (received / sold / balance, drug-wise)

- **Preconditions:** some medicines received and at least one dispense in the period (do §13 C2/C3).
- **Steps & expected:** open **Reports → Pharmacy stock.** Each drug shows **Opening, Received,
  Dispensed, Adjusted, Closing** for the period. Confirm it **reconciles**: closing = opening +
  received − dispensed + adjusted, on every row. **Download CSV** → a `stock-register-…csv` with the
  same figures.
- **Edge cases:** a drug with no movement in the window is omitted; a drug that went negative shows a
  negative closing (it is a real fact, not clamped); retired drugs still appear if they moved.

### R2 · Patient visits (how many, month-wise + by setting)

- **Steps & expected:** **Reports → Patient visits.** Headline **Total visits**, plus **outpatient**
  and **inpatient** counts; tables **by month** and **by care setting**. Cancelled and
  left-without-being-seen are excluded (they are not visits). CSV gives the month-wise table.

### R3 · Doctor load (which doctor saw how many)

- **Steps & expected:** **Reports → Doctor load.** Each doctor with the **number of patients** they
  saw in the period, busiest first, **by name** (not an id). CSV matches.
- **Edge cases:** a walk-in never routed to a doctor is counted in visits but against no doctor here; a
  deleted doctor shows as "Unknown (…id)" rather than dropping the row.

### R4 · Diagnostics (how many tests, and by whom)

- **Preconditions:** some lab/radiology orders in the period, ideally a few marked performed.
- **Steps & expected:** **Reports → Diagnostics.** **Tests ordered** vs **tests performed**; a
  **by-category** table (lab/radiology, ordered vs performed) and a **by-who-performed-them** table
  with the technician/radiologist's **name** and their count. CSV gives the performer table.
- **Edge cases:** pharmacy and other non-diagnostic orders are not counted; an order not yet performed
  appears in "ordered" but not in any performer's row.

### R5 · Collections (money received, month-wise + by method)

- **Preconditions:** at least one payment recorded on an invoice in the period.
- **Steps & expected:** **Reports → Collections.** **Total received** (₹) and **payments taken**;
  tables **by month** (₹ and payment count) and **by method** (cash / card / UPI…). These are payments
  actually RECEIVED in the window — keyed on the payment date, not when the invoice was raised. CSV
  gives the month-wise table in rupees.
- **Edge cases:** on a government hospital every consultation/test is ₹0, so collections are ₹0 unless
  a manual charge was paid; a non-admin has no **Reports** nav entry and every `/reports/*` route 403s.

### R6 · Discharges (how inpatient stays ended — the mortality / LAMA register)

- **Preconditions:** IPD edition (`module.ops.ipd`) and at least one IP stay that ENDED in the period —
  a routine discharge and/or a recorded outcome (§17). Do a couple of each for a meaningful table.
- **Steps & expected:** **Reports → Discharges.** Headline stats **Stays ended / Deaths / LAMA /
  Absconded**; tables **by outcome** (Discharged / LAMA / Absconded / Deceased) and **by month**. Counts
  are keyed on when the stay CLOSED (`dischargedAt`) in the window. CSV gives the by-outcome table.
- **Edge cases:** a stay closed before dispositions existed counts as **Discharged** (that is what it
  meant then), so totals never show a block of "unknown"; a clinic/diagnostic edition without beds gets
  **not in your edition** (HMS-PLAN-002) on this report, not an empty table.

## 16 · Multi-account testing — one account per browser tab (dev only)

Testing a hospital means being several people at once. The blocker was that the refresh token is
an httpOnly **cookie**, and a cookie is shared by every tab of one hostname — so the last login won
and all tabs collapsed onto one account. In development each tab now keeps its **own** session (its
refresh token in `sessionStorage`, refreshed from the request body), so tabs are independent.

> This is **development only** (`NODE_ENV !== "production"`). In production the httpOnly-cookie flow
> is unchanged — `sessionStorage` is readable by scripts, a trade only acceptable on a dev machine.

### M1 · Two accounts, two tabs (or windows), both stay logged in

Each tab/window is its OWN session. A new tab or window does **not** inherit a login (and must not —
inheriting the shared cookie is exactly what used to sign the other tab out); you sign in per tab.

- **Steps & expected:**
  - Tab 1: open `http://sunrise.localhost:3000` → you get the login page → sign in as
    `admin@sunrise.test` / `123456`.
  - Tab 2 — a new tab OR a separate Chrome window (same profile) — open the same URL → you get the
    login page (it does not adopt Tab 1's account) → sign in as `drrao@sunrise.test`.
  - Back in **Tab 1: reload** → still the admin. Reload Tab 2 → still the doctor. Signing in on one
    never signs the other out.
  - **Sign out** of Tab 2 → Tab 1 is unaffected.
- **Edge cases:** a **duplicated** tab inherits the original's account (the browser copies
  `sessionStorage` on duplicate) — expected. A brand-new tab shows the **login page**, not the last
  account — that is the fix; adopting the shared cookie was the bug.

### M2 · Recent-accounts chips (fill email only — never sign in)

- **Steps & expected:** after you have signed in as a few accounts on this hospital, the login page shows
  a **Recent accounts (dev)** row — one chip per account (name + role). Clicking a chip **fills the email
  and focuses the password box**; it does NOT sign you in — you still enter the password. The **✕** on a
  chip forgets it. The list is per hospital (`localStorage` is per hostname), so `sunrise` and `demo` keep
  separate lists.
- **Why not one-click:** a remembered account persists across logout and tab-close, so auto-signing-in
  from a chip would let the next person at the machine re-enter an account that had signed out. Filling
  the email (like a browser's saved-username list) keeps the convenience without that hole.

### M3 · Refresh + security still hold (verified end-to-end)

The per-tab change rides on the existing rotation/reuse machinery; a script (`authflow.mjs`) proved,
against the running API:

- login returns the refresh token in the body; **body-token refresh rotates** and **chains** (a tab can
  reload repeatedly);
- two accounts refresh **independently** (neither disturbs the other — the two-tabs guarantee);
- **reuse detection still burns the family**: replaying a spent token kills the live one too;
- **multi-tenant isolation holds**: a `sunrise` refresh token is rejected on `demo` (401), and a
  `sunrise` access token on `demo` is a tenant mismatch (403).

To re-run by hand: sign in as two roles in two tabs, reload each, and confirm each keeps its own role;
then sign out of one and confirm the other is unaffected.

---

## 17 · IPD terminal outcomes — telling a death from a homecoming

> ⏳ **Awaiting manual browser verification** (code-complete, all gates green, API endpoints
> live-checked). The end-to-end browser walk-through below — and R6 above, which it populates — have
> not yet been eyeballed on the seeded stack.

**Why:** every inpatient stay used to end as a plain "discharge", so death, a patient leaving against
medical advice, and an absconder all read alike in the record — and every census, ALOS and mortality
figure counted them alike. The stay now closes carrying WHICH of four endings it was
(`discharged | lama | absconded | deceased`), and the disposition rides on `patient.discharged` so those
figures can finally tell them apart. Bed-days bill the same for all four — the bed was occupied until the
ending happened, whichever it was.

- **Preconditions:** an IPD edition (`module.ops.ipd`), a patient admitted to a bed (do the admission flow
  in §ADMISSION). You need `admission:discharge`.

### T1 · Routine discharge is unchanged

- `POST /api/v1/encounters/:id/discharge` with a summary body still works exactly as before and now records
  disposition `discharged`. Confirm the encounter is `closed`, `dischargedAt` is set, `disposition:
"discharged"`, and the discharge summary exists.

### T2 · Non-routine ending — LAMA / absconded / deceased

- `POST /api/v1/encounters/:id/outcome` with `{ "outcome": "deceased", "text": "…circumstances / cause…" }`
  (also try `"lama"` and `"absconded"`).
- **Expect:** 201 with the outcome note; the encounter is now `closed` with `disposition` set to what you
  sent and `dischargedAt` recorded; a ward note of type `outcome_note` holds the account (`GET
/encounters/:id/notes?type=outcome_note`).
- **Record is honest:** `discharged` is NOT accepted here (400) — a routine discharge must go through
  `/discharge` with its summary; and `/outcome` refuses a stay that is not an open IP admission
  (HMS-STATE-001), the same guard discharge uses.

### T3 · The bed still bills

- After any T1/T2 ending on a bedded patient, the bed-day charges post from `patient.discharged` exactly as
  before — a death or a LAMA is billed for the nights the bed was occupied, not waived.

---

## 18 · Bed occupancy — one patient per bed

> ⏳ **Awaiting manual browser verification** (code-complete, gates green; the unique index was
> proven to refuse a second open stay in the same bed via a direct DB probe).

**Why:** the bed used to be RECORDED but not reserved, so nothing stopped two patients being put in
the same bed — the classic HIS double-allocation. A unique partial index (`one_open_stay_per_bed`,
migration 0020) now refuses a second OPEN stay in the same ward + bed; `admitPatient` turns that into
a clean 409. This is NOT a bed inventory — it still cannot tell you which beds are FREE, only that a
given bed is taken.

- **Preconditions:** IPD edition; two registered patients, each with an open OP encounter ready to
  admit. You need `admission:create`.

### B1 · A bed cannot hold two patients

- Admit patient A to, say, `ICU / A-12`. Admit patient B to the **same** `ICU / A-12`.
- **Expect:** B's admission is refused with **409 "That bed is already occupied"** (choose a free
  bed). A stays admitted; B is NOT left half-admitted — the whole admission rolls back in one
  transaction, so B keeps their open OP encounter and can be admitted to a different bed.

### B2 · Discharge frees the bed

- Discharge (or record an outcome for) patient A, then admit patient B into `ICU / A-12`.
- **Expect:** it succeeds — the index is partial on `open`, so a closed stay no longer holds the bed.

### B3 · Same bedCode in different wards is fine

- Admit into `ICU / A-12` and `General / A-12` at the same time.
- **Expect:** both succeed — a bedCode is unique only within its ward, so these are two beds.

---

## 19 · Forgot / reset password (verified end-to-end)

**Why:** every deployment needs a self-service way back into an account, and doing it well is a
security exercise, not a form. Reset links are single-use, expire in 60 minutes, are stored only as
a hash, and a successful reset signs every device out. The request step never reveals whether an
email belongs to an account — otherwise the box becomes a directory of who has a login here.

- **Verified against the running stack (2026-07-17):** forgot-password returns the SAME response
  for a real and an unknown email, and Mailhog received exactly ONE mail (the real account);
  the emailed link reset the password; reusing the token → 400; the new password logged in and the
  old one gave 401. Demo password restored to `123456` afterwards.

### P1 · Request a link

- **Sign-in page → "Forgotten your password?" → enter an email → "Send reset link".** You always see
  the same "if an account exists, we've sent a link" confirmation.
- Open **Mailhog** (http://localhost:8025): a real, active account gets a **"Reset your password"**
  email; an unknown or inactive one gets nothing. The response on screen is identical either way.

### P2 · Reset from the link

- Click the link in the email → **Choose a new password** (enter it twice) → **Reset password**.
- **Expect:** success, and every session is revoked — sign in again with the new password. The old
  password no longer works.

### P3 · The link is single-use and time-boxed

- Click the same link again after resetting → **"This reset link is invalid or has expired"** with a
  **Request a new link** button. Same message for a link older than 60 minutes, or a tampered token.
- Opening `/reset-password` with no `?token=` shows the "open the link from your email" state.

## 20 · Patient merge re-points every reference (⏳ eyeball)

**Why:** merging two duplicate records declares them one person, but the merged record keeps its row —
so appointments, encounters, allergies, prescriptions, orders, bills, dispenses, ward notes and
report files all still point at the _old_ id until something moves them. If they are not moved, the
survivor's chart is missing history a clinician is relying on. The most dangerous case is
**allergies**: an allergy left on the merged record is one the prescribing safety check will never
see. Merge now publishes `patient.patients.merged`, and every module that stores a `patientId`
consumes it and re-points its OWN references to the survivor (each module owns its collection — the
patients module never learns their names). At-least-once delivery is safe: re-pointing is idempotent,
so a redelivery moves zero rows.

**Out of scope, deliberately:** a patient-portal login (`users.patientId`) is an identity, not a
clinical reference — merging two charts does not merge two logins, which is a credential decision of
its own. It is intentionally NOT re-pointed here.

### G1 · A merged patient's history follows the survivor

- Pick two patients A (survivor) and B (duplicate) who BOTH have activity — book an appointment for
  each, record an allergy on B, and (if you can) start an encounter / add a bill for B.
- **Patients → find B → Merge into A** (needs `patient:merge`). Give a reason.
- **Expect:** open A's chart and B's activity is now there — B's appointment, allergy, encounter and
  any bill all appear under A. B's record still exists, marked _merged → A_, but holds no live
  references any more.

### G2 · The allergy safety net moves with the patient

- Record an allergy (e.g. Penicillin) on B, then merge B into A.
- Prescribe the matching drug for **A** → the safety check must fire on A, because the allergy is now
  A's. (Before this feature it would have stayed silent — the allergy was stranded on B.)

### G3 · Re-running is harmless (idempotent)

- A merge fires the event once; a redelivery (operator draining the queue, a restart) must change
  nothing. There is no user action for this — the guarantee is that `repointPatientId` matches the
  OLD id, which no longer exists after the first pass, so the second pass moves 0 rows. The
  per-module consumer logs `re-pointed … references to the surviving patient` with a count only when
  it actually moved something.

## 21 · Per-hospital public website (⏳ eyeball)

**Why:** a visitor who types a hospital's address (`sunrise.localhost:3000`) should meet that
hospital's own professional website — its name, services, doctors, contact — and step into sign-in
from there, exactly like a real hospital's site. The content lives in the hospital's OWN database
(`siteSettings`, one document per tenant), is served by a public, no-auth endpoint (`GET /api/v1/site`)
that resolves the tenant from the host, and is rendered server-side for SEO. A hospital that has saved
nothing still gets a full page: the service composes saved content over sensible defaults derived from
the hospital's name. Provisioning (and `pnpm migrate --all`, which backfills existing hospitals) seeds
a concrete starter site.

**Storage / editing:** content is the tenant's; only a hospital admin with `branding:manage` may edit
it (Phase B — §22). The doctors shown are pulled LIVE from the staff directory, opt-in per person, so
nobody's name reaches the open internet unless deliberately published, and a doctor who leaves stops
appearing with no edit to the site.

### S1 · The site renders at the hospital root

- Open **http://sunrise.localhost:3000/** (signed out). Expect a full landing page: brand name in the
  header, a hero with the tagline, a stats strip (24/7 · 20+ · 50+), a services grid, an About block,
  a contact section with opening hours, and a footer. The accent colour is the hospital's (default
  teal until changed).
- **Sign in** (header, hero and footer) → `/login`. After signing in, return to `/` — the button now
  reads **Go to dashboard** instead of Sign in.

### S2 · It is per-hospital and isolated

- **http://district.localhost:3000/** shows the district hospital's own name and content, independent
  of sunrise (separate tenant databases). An edit to one never touches the other.

### S3 · Fallbacks are graceful

- An **unknown host** (e.g. `nope.localhost:3000`) or the API being down shows a neutral "being set
  up" page with a Sign-in link — never a stack trace.
- A hospital whose site is **unpublished** (Phase B toggle) sends visitors straight to `/login`.

### S4 · SEO

- View source / browser tab on `/`: the `<title>` is `‹Hospital› — ‹tagline›` and there is a
  `<meta name="description">` plus Open Graph tags, all from the hospital's saved content.

### S5 · Doctors appear only when published (needs a flagged doctor — see §22)

- Until a staff doctor is flagged "show on public website", the **Doctors** section is absent. Once
  one is flagged (Phase B), they appear with name and specialty; the nav gains a **Doctors** link.

## 22 · Editing the public website (self-service) (⏳ eyeball)

**Why:** each hospital controls its own site without a support ticket. A hospital admin (anyone with
`branding:manage`, which `TENANT_ADMIN` inherits) edits it from **Administration → Public website**;
the server refuses the same endpoints for anyone without that permission, and the nav entry is hidden
from them. Verified live against the running stack (2026-07-18): logging in as the sunrise admin and
`PATCH /api/v1/site/settings` with a new accent + tagline was reflected immediately by the public
`GET /api/v1/site`.

### E1 · Edit the brand and copy

- Sign in as an admin at **sunrise.localhost:3000** (admin@sunrise.test / 123456) → **Administration →
  Public website**.
- Change the **display name**, pick an **accent colour**, edit the **tagline** and **about**, add a
  **service** and a **highlight**, fill in **contact** details → **Save changes**.
- Click **View public site →** (opens `/`) → every change is live, and the whole site is now tinted
  with the accent colour you picked.

### E2 · Announcement + publish toggle

- Add an **announcement** message → a strip appears across the top of the public site. Clear it → the
  strip disappears.
- Turn **Publish** off → visiting `/` signed-out now goes straight to `/login`. Turn it back on.

### E3 · Feature a doctor

- **Administration → Staff** → edit a **doctor** → tick **Show on the public website** → Save.
- Public site now shows a **Doctors** section with that doctor's name and specialty, and the header
  gains a **Doctors** link. Untick and save → they disappear (the flag is merged server-side, so the
  `false` genuinely clears it).

### E4 · Permission is enforced, not just hidden

- A user without `branding:manage` (e.g. a receptionist) has **no** "Public website" nav entry, and
  visiting `/settings/site` shows a "No access" notice. The API independently returns 403 on
  `GET/PATCH /api/v1/site/settings` for them — the hidden nav is convenience, not the guard.

## 23 · Patient profile & clinical timeline (⏳ eyeball)

**Why:** the most-asked hospital question — "who is this patient and what has happened to them?" — was
scattered across the encounter, order, prescription, billing and lab screens. The patient profile
gathers the whole record in one place: a header stating the safety-critical facts (allergies, dues) and
a timeline plus tabs tracing every visit, test, prescription and bill. It is read-only and built
entirely from existing per-patient endpoints, so any role can open it within its own permissions (a
strand the user cannot read, e.g. billing, simply shows empty rather than blanking the page). This is
the spine the later dashboard drill-downs link into.

### PP1 · Open a patient

- **Patients** (`sunrise.localhost:3000/patients`) → click a **UHID** or **name** → the profile opens.
- Header shows **name · UHID · age/sex · blood group · phone · registered-on**, an **allergy banner**
  (red chips when present, "No known allergies" otherwise), and — if anything is unpaid — a **Dues
  ₹…** pill. A **Start visit** button appears only with `encounter:create`.

### PP2 · The tabs

- **Timeline** — visits, tests ordered, results released, reports uploaded and prescriptions, merged
  and grouped by day, newest first (a critical result shows in red).
- **Visits / Tests / Prescriptions / Bills** — each lists the matching records with counts in the tab.
  A **released** lab result shows its summary; an uploaded report has a **Download** link. Prescriptions
  show per-line **dispensed / authorised** quantities. Bills show total / paid / **outstanding** + status.

### PP3 · Empty and dues

- A brand-new patient with no history shows clean empty states per tab and "No known allergies".
- Clicking the **Dues** pill jumps to the **Bills** tab; the outstanding figure = sum of unpaid
  finalized invoices.

## 24 · Role-aware dashboard & "my day" activity (⏳ eyeball)

**Why:** the dashboard used to show the same thin card to everyone. Now it is role-aware — a doctor
lands on their own day, an administrator on the hospital's numbers, everyone on the quick actions
their permissions allow. The **"My activity"** panel answers the question the user asked for directly:
"today I treated this many patients, sent this many to tests, prescribed this many medicines" — each a
click into the underlying list, each row a link to the patient chart. It is **self-scoped**: the
`GET /reports/my-activity` endpoint returns only what the caller personally did (keyed on
doctorId / orderedBy / prescribedBy), so it needs no `report:view` — you can always see your own work.
Verified live (2026-07-18): the endpoint answers `{ patientsSeen, tests, prescriptions }` for the
authenticated user over a half-open date range.

### D1 · A doctor's day

- Sign in as a **doctor** → the dashboard shows **My activity** with **Today / 7 days / 30 days**.
- Three cards: **Patients seen · Tests ordered · Prescriptions**. Click one → an inline list drops
  down; each row shows the patient (name + UHID) and the detail (test/status, or drugs), and links to
  that patient's profile. Switch the date range → the numbers and lists update.
- A day with no activity shows a plain "Nothing in today." rather than a broken panel.

### D2 · An administrator's view

- Sign in as an **admin** (has `report:view`) → below (or instead of) My activity, a **Today,
  hospital-wide** strip shows **patient visits** and **collected** (₹), with **All reports →**.

### D3 · Quick actions are permission-driven

- The **Quick actions** grid lists only what your roles allow (a receptionist sees Register / Reception
  / Billing; a lab tech sees Worklist; etc.). A role with none shows no grid.

## 25 · Lab worklist — tabs, filters & mark-complete (⏳ eyeball)

**Why:** the worklist showed one flat list of outstanding work. A technician now sees it the way they
work it — **Pending / In progress / Completed** tabs with live counts, a **filter-by-test** box, and a
**date filter** on completed work (Today / 7 days / All) so "what did we run today" is one click. A
quick **Mark complete** moves work whose deliverable is an uploaded document to "completed" without the
full values form, while still respecting the two-person rule (a technician completes; only a
pathologist/radiologist verifies and releases).

### W1 · Tabs and counts

- **Worklist** → pick a department (Blood & lab / X-ray / Procedures). Three tabs show with counts:
  **Pending** (placed/accepted), **In progress** (running / awaiting verify / awaiting release),
  **Completed** (released).
- Newly ordered tests land in **Pending** instantly (the order is the hand-off — no "send to lab" step).

### W2 · Filter and date

- Type in **Filter by test** → the list narrows to matching test names across the current tab.
- On **Completed**, switch **Today / 7 days / All** → the released history filters by release date.

### W3 · Run and complete

- On an **in-progress** order: **Enter result** (values + optional critical flag) as before, OR **Mark
  complete** → a short note prompt (defaults to "See uploaded report") → the order moves to Completed
  (status "completed", awaiting verification). **Upload report** still attaches a scan at any point.
- A technician never sees **Verify** / **Release** — those need category authority (pathologist for
  blood, radiologist for imaging). Once released, the item appears under **Completed** with "Released
  … — visible to the doctor."

## 26 · Front Office hybrid role (reception + cash) (⏳ eyeball)

**Why:** in a small hospital ONE person at the front desk both registers the patient and takes the OP
fee. Rather than staple two roles together, there is now a single **Front Office (Reception + Cash)**
role — the union of Receptionist and Cashier. It invents no new privilege: every permission it holds
already belongs to one of those two roles, so a hospital that separates the desk from the cash counter
simply grants the two roles instead. (The RBAC layer already unions permissions across roles; this just
gives the common combination a name.) Seeded to every hospital by `pnpm migrate --all` (roles 11 → 12).

### F1 · Assign it

- **Administration → Staff** → add or edit a person → role **Front Office (Reception + Cash)**. They
  can now register patients, manage the queue, create/finalize bills and collect payments — from one
  login.

### F2 · The registration-to-payment flow

- As Front Office: **Reception** → register/queue a walk-in and tag them to a **doctor**. Starting the
  encounter raises the consultation charge automatically — at THAT doctor's fee if one is set on their
  staff profile, otherwise the hospital's general consultation tariff.
- **Billing** → the charge is there to finalize and **collect** — same person, no hand-off.

_(The pharmacy wallet/budget with doctor override is the next slice — Phase 4B-ii.)_

## 27 · Worklist payment badge (paid before the lab runs) (⏳ eyeball)

**Why:** a technician about to run a test should see whether it has been paid for — but the system
must not hard-block them (an emergency, or a zero-tariff government patient, still gets run). So the
worklist now shows an advisory **PAID / UNPAID** badge per order, traced order → charge → invoice. It
is a status flag only (no amounts), so it is reachable with `order:read` — a lab technician sees it
without the counter's `billing:read`. Verified live (2026-07-18): `GET /billing/order-payments`
returns `unbilled` for an order with no charge.

### PB1 · The badge

- Open **Worklist** → each order shows, next to its status: **paid** (green), **unpaid** (red),
  **no charge** (zero-tariff / free), or **not billed** (no charge raised yet). No badge appears if
  the viewer's account cannot read billing status — the list still works.
- Register a walk-in, order a lab test, **collect payment** for it (Billing) → the test's badge turns
  **paid**. Before payment it reads **unpaid**; the technician can still run it (advisory, not a gate).

## 28 · Patient wallet — advance balance (OP & admission), settle bills from it (⏳ eyeball UI)

**Why:** a hospital takes money BEFORE the care is costed — an OP advance at reception, and (the case
this was built for) an **admission advance** when a doctor decides to admit. That money is credit the
patient holds; every treatment cost is settled against it, and the leftover is refunded on discharge.
The wallet is a per-patient stored-value account: an authoritative `walletAccounts` balance plus an
immutable `walletEntries` ledger, both moved together inside one transaction. The balance guard lives
in the **database query** (`balance: { $gte: amount }`), so two cashiers cannot both spend the same
₹500. Gated on `wallet:manage` (CASHIER, FRONT_OFFICE, TENANT_ADMIN).

**Backend verified live (2026-07-18, sunrise):**

- Deposit ₹500 (reason "Admission advance") → balance `50000`, ledger row carries `balanceAfter` + `by`.
- Partial refund ₹200 → balance `30000`, ledger `[refund, deposit]`.
- **Over-refund** (more than balance) → **422 "Insufficient wallet balance"** — the atomic guard holds.
- Paise-not-rupees fat-finger (amount `5000000000`) → **400** (capped at ₹10,00,000 per transaction).
- **Settle a bill from advance:** deposit ₹800 → pay a finalized ₹500 invoice with `method: "wallet"`
  → invoice goes **paid** (`paid 50000`, payment method `wallet`), wallet balance drops `80000 → 30000`,
  ledger gains a `debit` of `50000`. The debit and the invoice payment are one transaction — an
  insufficient balance throws and rolls **both** back (nothing half-done).

### W1 · The wallet panel (Cashier / Front Office login)

- Open a patient profile → a green **Advance ₹X** pill sits in the header next to any **Dues** pill,
  and a **Wallet** tab appears (only for `wallet:manage` — a doctor's view has neither).
- Wallet tab → a big **balance card**. When the patient owes money it reads "Covers current dues of ₹X"
  or "Short of current dues by ₹X". Below it, the full ledger (movement, +/− amount, running balance).
- **Add advance** → enter ₹, method (cash/card/UPI/net-banking), optional reason ("Admission advance")
  → the balance and ledger update. **Refund** → hands money back; disabled at zero balance, and a
  refund larger than the balance is refused.

### W2 · Settling a bill from the advance

- Deposit an advance, then open the **Bills** tab → a finalized invoice with an outstanding amount and a
  positive balance shows a **"Pay ₹X from advance"** button (X = min(outstanding, balance)).
- Click it → the invoice's paid/outstanding move, its status can reach **paid**, and the wallet balance
  drops by the same amount (a `debit` row in the ledger). If the advance only partly covers the bill,
  the rest stays owed and can be collected by another method.

## 29 · Audit reports — advance register, and collections that don't double-count (⏳ eyeball UI)

**Why:** once "wallet" is a way to pay a bill, a naive collections report double-counts. A ₹500 cash
advance is real money in the drawer; settling a bill "from advance" later is that **same** ₹500 moving
from the patient's advance to revenue — not a second ₹500. So the two reports are kept apart, each with
one meaning: **Collections** = money that crossed the counter directly (cash/card/UPI, wallet
EXCLUDED); **Advances** = the admission-advance story (collected, utilised, refunded, held). The wallet
is mostly an **admission** tool; OPD/walk-in patients pay per test directly, and those are collections.

**The reconciliation an auditor can trust:**
`money actually received = Collections (counter) + Advances collected − Advances refunded`.
"Utilised against bills" and "Settled from advance" are the SAME figure — a transfer, never new income.

**Backend verified live (2026-07-18, sunrise), reconciles to the ₹ test transactions above:**

- `GET /reports/wallet` → deposits ₹1300 (upi ₹800 + cash ₹500), refunds ₹200, **utilised ₹500**,
  **held ₹600**. Check: `deposits − refunds − utilised = held` (1300 − 200 − 500 = 600). ✓
- `GET /reports/collections` → counter **total ₹0**, **settledFromAdvance ₹500**. The one bill paid so
  far was paid from advance, so it is correctly OUT of the counter total and shown only as context. ✓
  (Before the fix this ₹500 would have inflated "total received".)

### R1 · Advances report (Reports → Advances, needs `report:view`)

- Pick a period → four figures: **Advances collected**, **Utilised against bills**, **Refunded**,
  **Currently held**. Below them, "collected by method" and "refunds by method" tables (cash/card/UPI).
- Read the one-line note: _utilised_ is a transfer to revenue (already counted at deposit), _currently
  held_ is a point-in-time liability (balance owed back to patients), not a period total.
- **Export CSV** → the advance-register file lists advances collected by method.

### R2 · Collections report now separates counter cash from advance

- Reports → **Collections** → three figures: **Collected at counter** (direct cash/card/UPI),
  **Payments taken**, **Settled from advance**. The note explains the last is shown for context only,
  counted in Advances — never added to the counter total. "By method" no longer lists `wallet`.

### R3 · End-to-end reconciliation walkthrough

1. As Cashier/Front-Office, **deposit ₹1000 cash** as an admission advance on a patient → Advances
   report: _collected_ +₹1000, _held_ +₹1000; Collections unchanged.
2. Run up a bill on that patient (consult + a test), finalize it, **Pay from advance** ₹600 → Advances:
   _utilised_ ₹600, _held_ ₹400; Collections: _settled from advance_ ₹600, _counter total_ unchanged.
3. **Refund ₹400** on discharge → Advances: _refunded_ ₹400, _held_ ₹0.
4. A second patient pays a ₹300 bill in **cash** at the counter → Collections: _counter total_ +₹300;
   Advances untouched. The two reports never overlap.

## 30 · Admission → advance, at the moment it happens (⏳ eyeball UI)

**Why:** the wallet is mostly an ADMISSION tool, so it should appear where a patient is admitted, not
only buried in the patient profile. Two touches: the doctor's admit confirmation now tells them to
**send the patient to reception for the advance**, and the **Ward chart** carries an **Admission
advance** panel — balance, whether it covers what the stay owes, and a one-click **Collect advance** —
for staff who hold `wallet:manage` (cashier / front office). A doctor's ward round never sees it. This
is frontend only; it reuses the wallet endpoints proven in §28.

### A1 · The admit nudge (Doctor login, `drrao`)

- **My patients** → open a patient in a visit → **Admit to a bed** → pick bed class + number → **Admit**.
- The success message reads: _"Admitted … Send the patient to reception to pay the admission advance."_
  The visit closes and the patient appears on the **Ward** list.

### A2 · The advance panel on the ward (Cashier login, `cashier`)

- **Ward** → pick the admitted patient → below the header, an **Admission advance** card shows the
  current balance (₹0 for a fresh admission).
- It reads **"Short of the ₹X owed by ₹Y — collect more"** when the running stay bill exceeds the
  advance, or **"Covers the ₹X this stay owes"** in green once the advance is enough. (The "owed"
  figure needs `billing:read`, which the cashier holds; a login without it just sees the balance.)
- **Collect advance** → amount + method (reason is stamped "Admission advance") → **Take advance** →
  the balance jumps and the coverage line re-colours. The deposit shows in the patient's Wallet tab
  ledger and in the **Advances** report (§29).
- A **doctor** opening the same ward chart sees the notes and (no) bill, but **no advance panel** — it
  is the cash counter's job, not the clinician's.

## 31 · Consult & worklist flow validations (⏳ eyeball UI)

Four related tightenings across the doctor's consult (My patients) and the lab **Worklist**. All
frontend, no backend change.

### C1 · Call in before you order or prescribe (Doctor, `drrao`)

- **My patients** → pick a patient who is **in the queue** (not yet called in). The right pane shows
  only the header with **Call in** and a line: _"Call the patient in to begin … press Call in above."_
  The **Order** and **Prescribe** pads are **not shown**.
- Click **Call in** → status becomes _in progress_ → the **Order** and **Prescribe** pads appear.
  Sending for tests / prescribing is now possible. (You cannot investigate or medicate someone still
  waiting in the queue.)

### C2 · Collapsible consult sections (Doctor)

- With a patient called in, the panel now stacks **Order**, **Prescribe**, **Allergies**, **Prescribed
  on this visit**, **Ordered on this visit** as **collapsible cards** (click the title to fold/unfold).
  Order/Prescribe start open; Allergies and the two history lists start folded with a **count** in the
  header, so the screen stays short — useful once the patient is sent to the lab.

### C3 · Pay before the lab runs (Lab technician, `labtech`)

- Order a lab test for a patient (as a doctor), do **not** pay for it → **Worklist** shows the test with
  an **unpaid** badge and, in place of the action buttons, **"Awaiting payment — held until paid at
  billing."** Accept / Start / Enter result / Upload are all withheld. (Cancel still works.)
- Collect payment for that test at **Billing** → back on the worklist the badge turns **paid** and the
  actions appear. A **free** (zero-tariff / government) or **not-billed** test is never held — only a
  real, raised, unpaid charge is.

### C4 · No completing on thin air (Lab technician)

- A test **in progress** shows **Enter result** and, instead of a bare "Mark complete", the hint
  **"Enter result or upload a report to complete."**
- **Enter result** refuses an empty result (the button stays disabled until a summary or a value is
  typed). **Upload a report** → once a document is attached, **Mark complete** appears and completes the
  order against that document. There is no way to mark a result complete with nothing entered or
  uploaded.

### C5 · Completed work reaches the Completed tab (Lab technician) — bug fix

- After **Enter result** (or Mark complete on an uploaded report), the test now moves to the
  **Completed** tab (previously it was stranded in _In progress_, because a technician cannot verify
  their own work). The card carries an _"awaiting verification"_ note until a pathologist/radiologist
  verifies and releases it; once **released** it reads _"visible to the doctor."_ The In-progress tab
  now holds only work actively being run.

## 32 · Express OP — paid fast-track visit (⏳ eyeball UI)

**Why:** some patients pay to be seen ahead of the queue. Reception marks the visit **Normal** or
**Express**; Express floats the patient above normal patients in the doctor's list (each group still in
token order) and adds an **express surcharge** on top of the consultation fee. It is a first-class
field on the encounter, priced through the same event-driven billing as the consultation — so
zero-tariff government hospitals flatten it to ₹0 like everything else, and a missing tariff never
blocks the visit.

**Backend verified live (2026-07-18, sunrise):** registering a visit with `express: true` →
`encounter.express = true`, and the bill carries **two** consultation lines — `CONSULT_GEN` ₹500 +
`CONSULT_EXPRESS` ₹200 = ₹700. The `CONSULT_EXPRESS` tariff (₹200) is seeded for new hospitals and was
added to the two dev tenants.

### E1 · Register an express visit (Reception / Front Office)

- **Reception** → choose a patient and doctor → under **Visit type** pick **Express (fast-track)** (a
  warning line explains the surcharge) → **Register arrival**. The confirmation notes the express
  surcharge is on the bill. Leaving it **Normal** behaves exactly as before.
- In **Who came in**, an express visit shows an **EXPRESS** pill next to the patient's name.
- Open that visit's **Bill** → two consultation lines: the consultation + **Express OP Surcharge**.
  (A zero-tariff hospital shows both at ₹0.)

### E2 · Express jumps the queue (Doctor, `drrao`)

- Queue two patients to the same doctor — one **Normal**, one **Express** — with the Normal one
  registered **first**. In **My patients**, the **Express** patient sorts **above** the Normal one and
  carries an **EXPRESS** pill, even though they arrived later. Two express patients keep their own token
  order between themselves.

## 33 · Take payment at reception — finalize ≠ pay (⏳ eyeball UI)

**Why (the bug you hit):** reception could **Finalize** a bill but there was **no way to record
payment**. Finalizing only freezes the lines into a numbered document; the money is a separate act.
So a test showed **unpaid** on the worklist and the lab held it — the bill looked "done" but nothing
had been collected. The reception bill panel is now a proper till: **Pending** (what's owed, with the
collect box) and **Cleared** (what's been paid).

**Verified live (2026-07-18, sunrise), reproducing the exact case:** order a Blood Glucose test →
payment status **unpaid**; **finalize** the bill → **still unpaid**; **record payment** of the
outstanding → **paid**. Only then does the lab worklist offer Accept/Start (§31 C3).

### P1 · Collect payment (Cashier / Front Office / Admin — needs `payment:collect`)

- **Reception** → open a visit's **Bill**. It lists the charges and a **Total**.
- If it is a **Draft**, press **Finalize bill** (needs `billing:finalize`) — this issues the numbered
  document. Payment cannot be taken on a draft (by design).
- A **Pending** panel now shows **₹X due** with an **Amount** box **prefilled to the full
  outstanding** (editable for a part payment) and a **Method** (cash / card / UPI / net banking) →
  **Record payment**.
  - Pay the full amount → the invoice flips to **paid** and moves to **Cleared**; a **part** payment
    leaves it **finalized** with the remainder still due.
- **Cleared** lists each payment (method, reference, date) and the total paid, with the invoice
  number and status.

### P2 · This is what unblocks the lab

- With a lab test ordered but the bill only **finalized**, the **Worklist** still shows **unpaid** and
  holds it (§31 C3). Come back to reception, **Record payment** → the worklist badge turns **paid** and
  Accept / Start appear. That is the end-to-end reception → pay → lab flow.

> Per-batch billing (consultation and tests as **separate** bills) is now built — see §35.

## 34 · OPD slip — the take-home summary (⏳ eyeball UI)

**Why:** at checkout the patient should walk out with one printed sheet — who saw them, the diagnosis,
what was tested and found, what was prescribed, the advice, and what it cost — on the hospital's
letterhead with its seal and the doctor's signature block. It is **composed** from data that already
exists (the encounter, its orders + results, its prescriptions, its bill) plus the hospital's own site
branding, and renders **outside the app shell** so it prints as a clean A4 sheet.

**New backend (verified live, sunrise):** the doctor records a visit **diagnosis** and **advice** —
`POST /encounters/:id/summary` (needs `emr:write`) → both persist on the encounter and print on the
slip. All the slip's other data (orders, prescriptions, bill) is already per-encounter.

### S1 · Record the visit summary (Doctor, `drrao`)

- **My patients** → call a patient in → open the **Visit summary** section → type a **Diagnosis** and
  **Advice** → **Save summary**. (Optional — a slip prints fine from the reason, tests and
  prescriptions without it.)

### S2 · Open & print the slip

- From **My patients** (consult header), **Reception** (each register row), or a patient profile's
  **Visits** tab, click **OPD slip ↗** → a clean printable page opens in a new tab with:
  - **Hospital header** — name, address, phone, and a circular **seal** in the hospital's accent
    colour (from Settings → Public website branding).
  - **Patient** (name, UHID, age/sex) and **doctor**; visit date and token; an **EXPRESS** pill if it
    was a fast-track visit.
  - **Chief complaint → Diagnosis → Investigations** (each test with its result or "See report") **→
    Rx** (a medicines table: drug, dose, route, frequency, days, instructions) **→ Advice**.
  - **Bill** — itemised charges, **Total / Paid / Balance**, and the invoice number (shown to anyone
    with `billing:read`; a doctor's view simply omits the money section).
  - A **signature block** with the doctor's name and a **Print / Save PDF** button (hidden on the
    printout).
- **Print / Save PDF** → the toolbar and app chrome drop away and it prints as a one-page A4 document.

## 35 · Per-batch billing — consultation and tests as separate bills (⏳ eyeball UI)

**Why:** a visit is paid in batches — the consultation at registration, the tests once a doctor has
ordered them, the pharmacy after. Each batch is its **own numbered bill**, and a charge that arrives
after a bill is issued lands on the **next** bill, never on the frozen one. This is what lets a patient
pay to see the doctor, then pay for the tests separately, and it is what makes the lab's paid-before-run
check turn green **per test**. Built on a per-batch view (`GET /encounters/:id/billing`) that returns
the pending (unbilled) charges plus every bill raised, with payment state.

**Backend verified live (2026-07-18, sunrise):** register → consultation is **pending ₹500** →
**issue bill** → `INV-…05 ₹500`. Order a Blood Glucose test → the test is a **new pending ₹120**
(the consultation bill is untouched) → **issue bill** → a **separate** `INV-…07 ₹120`. Two bills on one
visit; the test's lab gate keys off its own bill. The frozen-invoice contract and all 663 billing/RBAC
tests still pass.

### B1 · Two bills on one visit (Cashier / Front Office / Admin)

- **Reception** → register a patient (consultation charge appears) → open **Bill**. A **Pending — not
  yet billed** panel lists the consultation with **Issue bill for these** → it becomes an issued bill
  row with a number.
- **Record payment** on that bill (amount prefilled to its balance) → it reads **paid in full**.
- Now (as the doctor) order a test for the same visit. Back on the reception **Bill**, the test shows in
  **Pending** as a fresh batch — the consultation bill is unchanged. **Issue bill for these** →
  a **second** numbered bill. Pay it → **paid**.
- The footer shows the **Visit total** — paid vs grand total, and any amount still due across all bills.

### B2 · Each bill unblocks its own tests

- With the test on an **unpaid** second bill, the **Worklist** holds it (§31 C3). Pay **that** bill →
  the test's badge turns **paid** and the lab can start — even though the consultation bill was paid
  earlier and separately.
- The **OPD slip** (§34) and the **ward**'s "this stay owes" now read the whole-visit totals across
  every bill, so no two screens disagree on what is owed.

## 36 · Doctor signature on the OPD slip (⏳ eyeball UI)

**Why:** a printed OPD slip should carry the doctor's signature, not just their typed name.

**Verified live (2026-07-18):** a signature set on a doctor persists, is returned by the doctor card
(`GET /doctors/:id`), and a non-image string is refused (400).

### G1 · Upload a signature (Admin, Staff editor)

- **Staff** → edit a **doctor** → the profile form shows a **Signature** field (doctors only) → upload
  a PNG/JPG under ~200 KB → a preview appears → **Save**.

### G2 · It prints on the slip

- Open that doctor's **OPD slip** (§34) → the uploaded signature image appears **above** the signature
  line, over the printed **Dr <name>** and qualification. A doctor with no signature uploaded prints a
  blank space above the line for a wet signature, exactly as before.

## 37 · Session expiry → a clean bounce to login (⏳ eyeball UI)

**Why:** the reported bug — a hospital left a tab open overnight, came back, and pages showed
"session expired" / "could not load roles" while stranding the user on a dead screen. A page whose
session has ended should recover silently if it still can, and otherwise send the user to a login
form that explains what happened — never leave a broken page on display.

**How it works:** the API client now intercepts an expired-session error (`HMS-AUTH-002/003`) on
ANY request. It asks the auth provider to refresh once; if that succeeds the original request
replays transparently, if it fails the session is cleared and the user is redirected to
`/login?reason=expired` (the form then reads that reason and says "your session has expired"). A
burst of calls firing at once shares a single refresh, not one per request. Auth endpoints
(login/refresh/mfa/reset) are excluded so a bad password on the login page is untouched.

### H1 · Mid-session expiry recovers or bounces (the reported case)

- Sign in, open **Roles** (or any page). Leave the tab; let the access token expire (or force it —
  e.g. clear the in-memory token via a reload after the refresh cookie has also expired).
- Trigger any action that hits the API. **Expected:** either the page loads normally (silent refresh
  succeeded) OR you land on **/login** with the banner "your session has expired" — you are NEVER
  left on a page reading "Could not load roles".

### H2 · A still-valid session is not disturbed

- Normal use across several pages with a live session shows no extra redirects and no re-login — the
  interceptor only fires on a genuine `HMS-AUTH-002/003`.

### H3 · The login form itself still reports bad credentials

- On **/login**, enter a wrong password → you see the normal "invalid credentials" error and stay on
  the form (the interceptor skips auth endpoints, so it does not loop or redirect).

## 38 · Pay the OP fee before joining the doctor's queue (⏳ eyeball UI)

**Why:** a walked-in patient should not enter the doctor's queue until the consultation (OP) fee is
settled — the same pay-first discipline the lab already has for tests. The register now hides "Add to
queue" until the consultation is paid (or is free for a zero-tariff patient).

**How it works:** a new status-only endpoint `GET /billing/consultation-payments?encounterIds=…`
(reachable with `encounter:read`) returns **paid / unpaid / unbilled / free** per visit, traced
consultation-charge → invoice — the mirror of the lab's `order-payments`. The register reads it and,
for an `arrived` visit, draws **"Add to queue"** only when the fee is `paid` or `free`; otherwise it
shows an **"OP fee due"** chip. Because the fee is drawn on the same visit, `free` (₹0, government)
queues instantly with no friction. **Separation of duties:** a plain **RECEPTIONIST cannot take
money** (no `payment:collect`), so they see "Collect at cash counter"; a **CASHIER** or the combined
**FRONT_OFFICE** login sees **"Collect OP fee"**, which opens the bill panel — issue the bill, record
the payment — and the moment it is paid, **"Add to queue" appears** (the panel refreshes the gate).

### I1 · Unpaid walk-in is not queueable (as receptionist)

- Sign in as a **RECEPTIONIST**, register a walk-in (Normal). In "Who came in" the row shows an **OP
  fee due** chip and **"Collect at cash counter"** — there is **no "Add to queue"** button.

### I2 · Collect the fee, then queue (as Front Office / Cashier)

- Sign in as **FRONT_OFFICE** (or a CASHIER for the money step). On the unpaid row click **Collect OP
  fee** → the bill panel opens → **Issue bill for these** (a numbered bill INV-… is generated) →
  **Record payment** with the prefilled amount. The row flips to show **Add to queue**; click it and
  the patient gets a token and moves to `in queue`.

### I3 · A zero-tariff (government) patient queues immediately

- On a government-edition tenant (consultation ₹0), a registered walk-in shows **Add to queue** at
  once — the gate reads `free`, never "OP fee due".

### I4 · The bill is generated as part of paying

- After I2, the visit carries a numbered consultation bill marked **paid**; it prints on the patient's
  **OPD slip** (§34) and appears in collections (§29). Tests ordered later bill separately (§35).

## 39 · Payment receipt — the money proof at every counter (⏳ eyeball UI)

**Why:** each payment point in a visit (OP fee, tests, pharmacy) should hand the patient a printable
receipt. Rather than three documents, all three are one reusable page keyed on the bill.

**How it works:** a standalone print page `/receipt/[invoiceId]` composes the receipt from the invoice
that already exists — its **number is the receipt number**, its lines are the items, its `payments`
are the money actually taken — with the hospital's header + seal and a **PAID / PART PAID / DUE**
stamp. It reads `GET /invoices/:id` (needs `billing:read`, which reception, cashier and pharmacist
hold). It is deliberately separate from the OPD slip (§34): the slip is the clinical take-home, this
is the financial record.

### J1 · Receipt from reception

- Reception → open a visit's **Bill** → each issued bill row now has a **Receipt ↗** link → opens a
  clean printable slip with the hospital header, receipt number, items, total, amount paid + method,
  and a green **PAID** stamp (or **DUE** when unpaid). **Print / Save PDF** yields an A4 slip with no
  app chrome.
- Do it for the **consultation** bill (receipt #1), the **tests** bill (receipt #2), and the
  **pharmacy** bill (receipt #3) — same page, three bills.

### J2 · Part-paid and unpaid stamps

- A bill paid in part shows **PART PAID** and a **Balance due** line; an unissued/unpaid one shows
  **DUE**. The stamp colour matches (green / amber / red).

## 40 · Admitted patient — settle a test from the advance (⏳ eyeball UI)

**Why:** an inpatient's advance is collected up front; their x-ray or blood test must not wait at a
cash counter like an OP test. The lab technician should see the patient is admitted and their advance,
and proceed by drawing the test straight from that advance — even into a negative balance, so a report
is never held.

**How it works:** two endpoints, both reachable with the technician's own order permissions.
`GET /billing/order-settlement?orderIds=…` (`order:read`) returns per order **{ admitted,
advanceBalance, amount }**. `POST /billing/orders/:id/settle-from-advance` (`order:perform`) bills that
one test into its own invoice and pays it from the wallet in one transaction — this draws DOWN an
advance the desk already collected (not new cash), so the technician may do it, and the ledger records
who. For an **IP** patient the wallet debit is **allowed to go negative**; an **OP** test is refused
here (pay at the counter). Only the wallet's admitted path can go negative — refunds and OP settles
still cannot.

### K1 · Admitted test shows advance + proceed

- Admit a patient (ward), collect an advance. As the ordering doctor order a **blood test / x-ray**.
- Sign in as **LAB_TECHNICIAN** → Worklist. The unpaid test now shows **"Admitted · Advance ₹X"** and
  a **"Proceed — deduct ₹Y"** button (instead of "Awaiting payment"). Click it → the test flips to
  **paid**, the advance drops by ₹Y, and Accept/Start/Upload become available.

### K2 · Negative balance never holds a report

- Order a test whose amount **exceeds** the remaining advance. **Proceed** still works; the balance
  goes **negative (shown in red)** and the notice says the ward should collect the shortfall. The
  report is not held. Confirm the negative balance on the ward panel / patient Wallet tab.

### K3 · OP test is refused the advance path

- For a normal **OP** patient, the worklist shows the ordinary **"Awaiting payment — pay at billing"**,
  not the advance panel. (If the settle endpoint is called for an OP order it returns 422.)

## 41 · Errors carry a traceable reference (⏳ eyeball UI)

**Why:** when something fails, we should be able to find the exact cause. Every API error already
carries a stable `code` and a `traceId` that is stamped on the server log line for that request;
surfacing them in the UI turns "it didn't work" into a thread back to the one log line.

**How it works:** `lib/errors.ts#describeError` extracts `{ message, reference }` from any thrown value
(prefers a field-level validation message, then the error message; reference = `code · traceId`). The
shared **`ErrorAlert`** component renders the message with a small monospaced **`Ref: …`** line.
Adopted on **reception** and **worklist**; other screens can drop it in the same way.

### L1 · A failure shows a reference

- Force an API error on **reception** or **worklist** (e.g. act on a stale row). The red alert shows
  the message plus a **`Ref: HMS-… · <traceId>`** line. Search the API logs for that `traceId` and it
  is the exact request that failed.

## 42 · Advance receipts & the receipts register (⏳ eyeball UI)

**Why:** a patient should get a receipt for EVERY payment — the OP fee, tests, pharmacy (bill
receipts, §39) and now the **advance** they deposit (OP or admission). And any receipt must be
findable and re-printable later for verification.

**How it works:** an advance deposit is a wallet entry, so it gets its own printable page
`/receipt/advance/[entryId]` (same hospital-branded chrome as the bill receipt, a green **RECEIVED**
stamp, receipt no **`ADV-…`**), fetched via `GET /wallet/entries/:id` (`wallet:manage`). A new
**Receipts** register (`/receipts`, **Finance** nav, `report:view`) reads
`GET /reports/receipts?from&to` — which merges issued **bills** and advance **deposits** with patient
names (reporting composes billing + wallet + patients server-side) — and links each row to its
printable receipt. Both bill and advance receipts open **in the same tab** (the print pages need the
signed-in, per-tab-in-dev session) and both have a **← Back** button.

### M1 · Advance deposit gives a receipt

- Ward → a bed → **Admission advance** → **Collect advance** → **Take advance**. The success line
  now offers **"Print receipt →"** → opens a professional advance receipt with the hospital header,
  **ADV-…** number, amount, method and a **RECEIVED** stamp. **Print / Save PDF** is clean.
- Same from a patient's **Wallet** tab: each **deposit** row in the ledger has a **Receipt →** link.

### M2 · The receipts register finds and reprints any receipt

- **Finance → Receipts**. Defaults to today; set a **From/To** range. The table lists every payment —
  **Bill** rows (INV-…) and **Advance** rows (ADV-…) — with patient, amount and time, newest first,
  and a running **Total**.
- **Search** by patient name, UHID or receipt number narrows the loaded period.
- Click **Receipt →** on any row → the exact printable receipt (bill or advance) reopens — the
  cross-check / reprint path.

### M3 · Regeneration by id

- The receipt URLs (`/receipt/<invoiceId>` and `/receipt/advance/<entryId>`) are stable — the same
  receipt reprints whenever opened, so a lost slip is always recoverable.

## 43 · Inpatient treatment sheet & discharge summary (⏳ eyeball UI)

**Why:** an admitted patient's record is a story told over days, not the one-moment OP slip. Two new
printable documents cover it: a day-wise **treatment sheet** for the file, and a formal **discharge
summary** handed over at the end.

**How it works:** both are standalone print pages composed from data that already exists (encounter,
ward notes, orders, prescriptions, dated charges via new `GET /encounters/:id/charges`, the advance
ledger, and per-encounter billing), hospital-branded with the seal and the consultant's signature.
They open **same-tab** (dev per-tab session) and fail gracefully with a sign-in prompt.

### N1 · Treatment sheet is day-wise, money inline

- Admit a patient; add a **ward note**, order a **test**, prescribe a **drug**, and collect an
  **advance**; on another day (or after a bed-day posts) let more charges accrue.
- **Ward → the patient → Treatment sheet →**. Expect: an IP header (admitted date, bed, consultant,
  status) and a **money summary** (advance balance — red if negative — total charges, paid/drawn,
  outstanding), then **Day 1 … Day N** sections, each grouping that day's **notes, investigations,
  medications, charges (with a day subtotal) and advance movements**. **Print** gives a clean A4 sheet.

### N2 · Discharge summary reads as a handover + settlement

- Discharge the patient with a summary (ward Discharge form) — or open it before discharge to see the
  **"Provisional — not yet discharged"** badge.
- **Ward → the patient → Discharge summary →**. Expect: **final diagnosis**, **course of stay** (the
  discharge-summary ward note), **discharge medications** table, **advice & follow-up**, and a **final
  settlement** block — total charges, paid/drawn from advance, advance balance, and either a **balance
  payable** (red) or a **refund due** (green) or **settled in full**.

### N3 · Not an inpatient

- Opening either page for an OP encounter shows a plain "this is for admitted patients" message, not a
  broken sheet.

## 44 · Session model: workstation inactivity lock (⏳ eyeball UI)

Background: access token = 15 min (silently auto-refreshed), refresh/session = 30 days ABSOLUTE
(rotation does not extend it — `apps/api/src/config/env.ts`, `auth.service.ts`). Returning within 30
days lands you on the dashboard with no login — that is a correct "keep me signed in" session. The
inactivity lock (`components/IdleGuard.tsx`, `lib/idle.ts`) is the separate workstation control.

For a fast manual test, set `NEXT_PUBLIC_IDLE_TIMEOUT_MINUTES=1` and
`NEXT_PUBLIC_IDLE_WARN_SECONDS=20` in `apps/web/.env`, then restart the web app.

### O1 · Warning then auto sign-out

- Sign in, then do nothing (don't move the mouse) for ~40s → the "Still there?" dialog appears with a
  live countdown. Keep waiting → at 0 you are signed out and land on `/login?reason=timeout` showing
  "You were signed out after a period of inactivity."
- The session is genuinely gone: pressing Back / reloading a protected page does NOT restore it (logout
  revoked the refresh family server-side).

### O2 · "Stay signed in" resets the clock

- Let the dialog appear, click **Stay signed in** → dialog closes, you remain on the page, and the
  timer restarts (no sign-out until another full idle period passes). A jiggled mouse while the dialog
  is open does NOT dismiss it — only the button does.

### O3 · Machine sleep / background tab

- With the dialog logic armed, switch to another tab (or lock the laptop) for longer than the idle
  limit, then return → you are signed out on the spot (the check runs on focus/visibility, not only on
  a timer that a sleeping machine never fires).

### O4 · Public pages and login are unaffected

- The lock never arms when signed out: the hospital public site (`/`) and `/login` can sit idle
  indefinitely with no dialog.
- Set `NEXT_PUBLIC_IDLE_TIMEOUT_MINUTES=0` → the lock is fully disabled (no dialog ever). Restore to
  `30` for normal use.

## 45 · Free follow-up within the OP validity (⏳ eyeball UI)

The consultation tariff carries `followUpDays` ("OP validity"). A revisit to the SAME doctor inside
that window, where the first consultation was actually PAID, posts the consultation at ₹0 instead of
charging again. Run `pnpm --filter @medicore/api migrate -- --all` first (migration `0024`).

Setup: **Tariff → CONSULT_GEN → edit** → set **OP validity (days) = 15** → save. The row shows a
`15-day follow-up` badge.

### P1 · First visit is charged, follow-up is free

- Register patient P with Dr A → reception shows **OP fee due**. Collect it (invoice → paid).
- Register P again with **Dr A** (same day or a few days later) → the consultation posts at **₹0**,
  reception shows **Add to queue** with a **No fee** chip, and no cash-counter detour.
- Open that visit's bill → the line reads
  `Consultation — free follow-up (within 15 days of <date of the first visit>)`.

### P2 · The four conditions

- **Different doctor**: register P with **Dr B** → charged the normal fee (the window is per-doctor).
- **Unpaid original**: new patient Q, register with Dr A but do NOT pay → register Q again with Dr A →
  still **charged** (an unpaid consult entitles nobody to a free one).
- **Outside the window**: set validity to `1`, and revisit after the window has passed → charged again.
- **A waiver does not extend itself**: after a free follow-up, the NEXT visit is still measured from
  the original PAID consultation, not from the free one (a ₹0 line never opens a new window).

### P3 · Off by default / turning it off

- Set OP validity to blank or `0` → every visit is charged again, immediately. This is the default for
  any hospital that never configures it, and for all existing tariffs.

### P4 · Express is still chargeable

- A follow-up patient registered as **express** pays the express surcharge (a fast-track is a separate
  purchase) while the consultation line itself remains ₹0.

## 46 · Vitals & observations (⏳ eyeball UI)

New `vitals` module. Run `pnpm --filter @medicore/api migrate -- --all` first (migration `0025`).
Permissions: **`vitals:record`** to chart (NURSE, DOCTOR — reception does NOT have it),
**`emr:read`** to read (a receptionist must not see a patient's blood pressure).

### Q1 · A nurse charts observations

- Sign in as a **nurse**. Open **Patients → a patient with an open visit → Vitals** tab.
- The form appears with the current visit named above it. Enter BP `130/85`, pulse `92`,
  temperature `38.2`, SpO₂ `96` → **Save observations**.
- The reading appears under "Most recent" with **BP, temperature flagged** (arrow + colour) and an
  **"Outside normal range"** badge. Pulse and SpO₂ read as normal.
- Enter only a pulse and save → it saves fine (a partial set is valid). Save with every box blank →
  refused with "Enter at least one observation".

### Q2 · The doctor sees them at the point of care

- Sign in as the **doctor**, open **My patients → that patient**. The **Vitals** card is present and
  **already expanded** because the reading is abnormal. It sits ABOVE the "Call the patient in"
  gate — a doctor must be able to read obs before deciding to call someone in early.
- Weight + height on one reading → **BMI** is shown, derived by the API.

### Q3 · Entry guards

- Enter systolic `80` and diastolic `120` → refused: "diastolic must be lower than systolic". This is
  the commonest vitals typo and it silently corrupts every trend once charted.
- A temperature of `50` or a pulse of `500` is refused as implausible; a systolic of `250` is
  ACCEPTED — a hypertensive emergency must be chartable.

### Q4 · Inpatient day sheet

- For an admitted patient, chart obs on two different days, then open **Ward → patient →
  Treatment sheet**. Each day leads with an **Observations** line —
  `BP 130/85 ↑ · HR 92 · T 38.2 ↑ · SpO2 96%` — before the progress notes.
- **Print it**: the arrows survive on a monochrome ward printer (abnormality is never colour-only).

### Q5 · Reads are gated

- Sign in as a **receptionist**: the patient profile shows **no Vitals tab** (no `emr:read`), and
  `GET /api/v1/patients/<id>/vitals` returns **403**.

### Q6 · Append-only

- There is no edit or delete control anywhere. A wrong reading is corrected by charting a new one —
  the sequence IS the chart, and a doctor may have prescribed against the old value.

## 47 · Multi-branch — the active-branch context (ADR-0015) (⏳ eyeball UI)

Branches are physical sites of one tenant, sharing its DB, patient UHID and staff. Run
`pnpm --filter @medicore/api migrate -- --all` first (migration `0026` + the Main Branch seed +
backfill). A super-admin sets a tenant's cap via `limits.maxBranches` on the master record.

### R1 · Backward compatibility (single-branch)

- An existing hospital after `migrate --all` has ONE branch, **Main Branch**, and every historical
  record now belongs to it (the seed backfills `patients/encounters/orders/charges/…`). Everything
  works exactly as before; the header switcher does NOT appear (nothing to choose).

### R2 · Create branches

- **Administration → Branches** (needs `branch:manage`). Add "Apollo Chennai" (code `CHN`). Adding
  beyond `maxBranches` fails with **HMS-PLAN-001** ("Plan limit reached", metric `branches`).
- The Main Branch shows a **Main** badge and cannot be deactivated.

### R3 · The switcher + write stamping

- With ≥2 branches, the header shows a **branch switcher**. Pick "Apollo Chennai" → the app refreshes;
  every list now shows Chennai only.
- Register a patient / start an encounter while Chennai is active → the record is stamped
  `branchId = Chennai`. Switch to "Main Branch" → that patient is NOT in Main's reception list, but IS
  found by UHID search (identity is tenant-wide).
- An admin who can reach several branches and selects **All branches**, then tries to create a
  record → the write is refused with **HMS-BRANCH-001** ("pick a branch"). Reads still aggregate.

### R4 · All-branches aggregate

- Select **All branches** (offered only to users whose binding reaches >1). Reports/dashboards and
  lists aggregate across every branch. Select one branch → the same screens scope to it.

### R5 · Branch-confined staff

- Give a receptionist `branchScope: branches` + only Chennai (Roles/staff binding). They see only
  Chennai's patients and queue; the switcher shows just Chennai; writes stamp Chennai automatically
  (no prompt — a single-branch user never chooses).

### R6 · Reads scope live

- A hospital-wide user selecting Chennai sees Chennai; the selection is validated against the live
  allowed set every request, so a stale `X-Active-Branch` for a branch they lost access to is ignored
  (falls back to their own scope), never leaked.
