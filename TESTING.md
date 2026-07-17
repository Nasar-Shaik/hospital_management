# TESTING — How to run and test locally

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
| MongoDB                 | `27018` | `mongodb://127.0.0.1:27018/?directConnection=true` | `pnpm docker:dev` |
| Redis                   | `6380`  | `redis://127.0.0.1:6380`                           | `pnpm docker:dev` |
| Mailhog (fake inbox)    | `8025`  | http://localhost:8025                              | `pnpm docker:dev` |
| MinIO console (S3)      | `9001`  | http://localhost:9001 (`minioadmin`/`minioadmin`)  | `pnpm docker:dev` |

**Mongo is on 27018 and Redis on 6380, not their defaults.** Another project on this machine (the School ERP containers) already binds 27017/6379. Do not "fix" these back.

**Mongo is 27018 on _both_ sides of the container — that one is load-bearing, not cosmetic.** A replica-set client follows the address the server advertises rather than the one you typed. If mongod listened on 27017 internally it would have to advertise `localhost:27017`, which from the host is the _School ERP's_ Mongo — and since both replica sets are named `rs0`, the driver would have followed it there believing it had found our primary. Publishing `27018:27018` makes the advertised address true from inside and outside, so discovery resolves back to us. Changing the internal port re-opens that hole.

### If a port is still taken

Override it — never edit the compose file, because 27018/6380 are also baked into `.env.example`, CI and the docs:

```bash
MONGO_PORT=27019 REDIS_PORT=6381 pnpm docker:dev
# then point apps/api/.env at the same ports
```

Overriding `MONGO_PORT` breaks the both-sides-equal property above: the host would publish 27019 while the replica set still advertises 27018, so topology discovery points at a port that has nothing on it. Every URI in this repo carries `directConnection=true`, which skips discovery, so this is survivable — but a bare URI in Compass will fail until you also map the container's 27018 to the same number.

### The port trap that nearly cost us a database

**A loopback address does not prove the database is local.** An SSH tunnel like `ssh -L 27018:127.0.0.1:27017 user@remote` binds _our_ port on `127.0.0.1` and quietly wins the bind over Docker — after which everything connecting to `127.0.0.1:27018` is talking to a **remote** server. Our integration tests drop databases.

The harness now refuses to run unless the target is loopback **and** has no authentication (the dev container runs open; real servers don't), and it will only ever drop databases named `test_*` or `hms_test-*`. If you see `REFUSING TO RUN`, something else has taken the port:

```bash
lsof -nP -iTCP:27018 -sTCP:LISTEN     # an SSH tunnel? another container?
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

## 11. What you cannot test yet (updated 2026-07-16)

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

## 12. Manual Verification — enhancement tracks (2026-07-16)

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
