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

## 1d. THE CLINICAL DEMO — what you can actually test (updated 2026-07-16)

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
6. **Cashier** (`cashier@…` → **Billing**) — consultation + tests + **only the drugs actually
   handed over**. **Finalize** (freezes it, assigns a number) → take payment. Overpayment is
   refused; a draft bill cannot be paid.
7. **Do it all again at `district.localhost:3000`.** Same clicks, same code, **every line ₹0.00**
   with the real price struck through. A ₹0 invoice is marked paid the moment it is finalized —
   a government hospital must not accrue a pile of "unpaid" bills nobody will ever pay.

### Try to break it

All of these are enforced by the **database or the state machine**, not by a hopeful `if`:

| Try this                                            | What happens                            | Why                                                                                |
| --------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| Dispense 11 of 10 tablets                           | **Refused**                             | The guard is in the query — two pharmacists both seeing "2 left" can't both give 2 |
| Dispense against an unsigned draft                  | **Refused**                             | A draft is a doctor thinking out loud                                              |
| Doctor stops the drug, then dispense                | **Refused**                             | They may have stopped it for an allergy. Already-given doses stay on the record    |
| Edit a signed prescription                          | **Refused**, and it names the way out   | It is a legal instrument the moment it is signed                                   |
| Double-click Order or Dispense                      | **One** order, **one** handover         | Idempotency key + unique index — the case a disabled button cannot save you from   |
| Sign an empty prescription                          | **Refused**                             | A legal instrument authorising nothing                                             |
| As reception, open the order book or a prescription | Not in the nav; **403** if you force it | A drug name is a diagnosis: lithium says bipolar, tenofovir says HIV               |
| As the pharmacist, try to write a prescription      | **403**                                 | They are the second pair of eyes, not the first                                    |
| As a doctor, try to verify your own lab result      | **403**                                 | You would be the only pair of eyes on it                                           |

### Known rough edges (real, not bugs to report)

- **The pharmacist's "this visit owes" lags ~1.5s** after dispensing. Billing _listens_ — the
  drug charge is posted once the relay delivers the event. It converges; it is not instant.
  **Do not take payment off that number yet.**
- **A new hospital's Rx pad is empty** until you run `migrate --all` — the drug tariff seeds there.

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
pnpm --filter @medicore/api test:int                     # 602 integration tests (isolation, auth, RBAC matrix, encounters, orders, billing, prescriptions + pharmacy)
```

`test:int` needs `pnpm docker:dev` running. **602 tests across 13 suites** against a **real** MongoDB and Redis, and it **fails rather than skips** if either is missing — a silently skipped isolation suite looks exactly like a passing one.

All gates, as of **2026-07-16**: integration **602 passing**, typecheck 17/17, lint 17/17, build 11/11, module boundaries **0 violations** across 629 modules, **111 API routes** — every one carrying a permission that a test asserts, because the route nobody thought about is the one that answers everybody.

**Known flake:** one run once showed `1 failed | 437 passed` and the test was not captured; it has not reproduced since. Suspected the Mailhog timing suite under load. Recorded as debt in `PROJECT_MEMORY` §5. **It must not be "fixed" by deleting the assertion.**

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

**Next up — Slice 4:**

- **Admission / IPD** — admit from a consultation, daily notes, discharge summary, bed-day charges.
  The bed tariff is already seeded and the state machine is specified; the module is not written.
- **Transfer a case to another doctor.**

**Deliberately absent, and dangerous to pretend otherwise:**

- **Pharmacy stock.** No batches, no expiry, no purchasing. The counter **will let you dispense a
  drug the shelf does not have.** A half-built stock number is worse than none — people believe
  it, and a number that is only sometimes decremented is trusted right up until it matters.
- **Allergy, interaction and duplicate-therapy checking.** _Nothing_ checks them. This is the
  single highest clinical value a prescribing system can add, and it is absent. A
  half-implemented allergy check is worse than none: it teaches a doctor the machine is
  watching, and then one day it isn't. **The first thing the EMR slice must bring.**
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
