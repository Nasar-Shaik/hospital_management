# SEED — copy-paste commands to set up data

Run these from the **project root** (`medicore-hms/`). You only seed once — the data lives in the
database and survives restarts.

> **Before any seed command, have these two running** (each in its own terminal):
>
> ```bash
> pnpm docker:dev     # the databases
> pnpm dev            # the app
> ```

---

## ⭐ The fastest path (just do this)

Three commands give you everything — the console admin, two ready-made hospitals with all staff,
prices and drugs, and a set of demo patients:

```bash
pnpm seed:demo
pnpm seed:migrate --all
pnpm seed:clinical
```

Then sign in (see **Logins** at the bottom). That's it — you don't need anything else below.

> ### ⚠️ `seed:migrate --all` is not optional on a database you already had
>
> Migrations run inside hospital PROVISIONING, and `seed:demo` skips provisioning for a hospital that
> already exists. So a database created weeks ago keeps running on the schema it was born with, and
> **nothing tells you**.
>
> On 2026-08-14 this was found on all four local tenants: two migrations behind, and therefore **no
> unique index on `medicationAdministrations`** — the constraint that stops the same dose being given
> twice. A safety probe against that database reported seven failures that were all the _absence_ of
> the mechanism, not a fault in it. They vanished the moment the migrations ran.
>
> Run it after every `seed:demo`, and before any testing you intend to believe.

---

## Preparing the MANUAL-VALIDATION ward

For working **`AI_Workflow/docs/MANUAL_VALIDATION_RUNBOOK.md`** — the authoritative procedure for
manual M2/M3/Web validation, which starts with these commands as its `ENV-01`…`ENV-04`. Builds a real
ward — 45 beds, 42 admitted patients, a second site in another timezone, prescriptions with due and
overdue doses, allergies:

```bash
pnpm seed:demo
pnpm seed:migrate --all
pnpm seed:validation
pnpm seed:validation -- --verify     # 19 read-only checks; run it any time
```

`--verify` writes nothing. **It checks both the clinical test DATA and the database SCHEMA** — the
unique indexes without which "the same dose cannot be charted twice" and "a retry replays instead of
repeating" are not rules but hopes. If the schema cannot enforce them it prints `VALIDATION BLOCKED`
with the remediation and exits non-zero, rather than reporting READY on an environment where the
thing being validated cannot fail. The seeding run refuses on the same check, so a ward is never
built into a database that cannot police it.

It also reports what the environment contains and, when the ward has no overdue dose yet, tells you
the wall-clock minute the first one appears — a course runs from `signedAt`, so a prescription
written at noon has no 08:00 dose to be late for.

It seeds **no vitals, no nursing notes and no administered doses** on purpose: those are the writes the
checklists exist to exercise.

---

## Individual commands (run only the one you need)

### 1 · Console admin — the operator login (port 3001)

```bash
pnpm seed:operator
```

Creates it, or resets its password if it already exists — so it **always works**. Then open
**http://localhost:3001** and sign in:

| Email                  | Password |
| ---------------------- | -------- |
| `ops@paperlesstech.in` | `123456` |

Want your own email instead? Pass them in:

```bash
pnpm seed:operator --email nasar@paperlesstech.in --name "Nasar" --password '123456'
```

### 2 · Create a hospital (with its admin login)

Example — a hospital called **Greenwood Clinic** living at `greenwood.localhost`:

```bash
pnpm seed:hospital --name "Greenwood Clinic" --slug greenwood --plan PLAN_HOSPITAL --admin-email admin@greenwood.test --admin-password '123456'
pnpm seed:migrate --slug greenwood
```

- `--slug greenwood` is the web address: the hospital opens at **http://greenwood.localhost:3000**.
- For a **government (₹0) hospital**, add `--org-type government_hospital`.
- The second line sets up that hospital's database (prices, drugs, indexes). Do it right after creating.

Now sign in at **http://greenwood.localhost:3000** with `admin@greenwood.test` / `123456`.

> Pick your own name and slug. If a slug is **already taken**, choose a different one.

### 3 · Fill a hospital with demo patients

The built-in **Sunrise** demo hospital:

```bash
pnpm seed:clinical
```

A hospital **you** created (it needs a doctor account inside it):

```bash
pnpm seed:clinical --slug greenwood --doctor drrao@greenwood.test
```

Adds ~6 patients spread across the flow — some waiting in the doctor's queue, some mid-consult, some
with tests at the lab. (Bills appear a second or two later, once the workers process them — keep
`pnpm dev` running.)

---

## Logins (every password is `123456`)

| Who                                   | URL                            | Email                                             |
| ------------------------------------- | ------------------------------ | ------------------------------------------------- |
| **Console admin** (manages hospitals) | http://localhost:3001          | `ops@paperlesstech.in`                            |
| **Sunrise** — hospital admin          | http://sunrise.localhost:3000  | `admin@sunrise.test`                              |
| Sunrise — doctor                      | http://sunrise.localhost:3000  | `drrao@sunrise.test`                              |
| Sunrise — reception                   | http://sunrise.localhost:3000  | `reception@sunrise.test`                          |
| **Sunrise — nurse**                   | http://sunrise.localhost:3000  | `nurse@sunrise.test`                              |
| **Sunrise — second nurse**            | http://sunrise.localhost:3000  | `nurse2@sunrise.test`                             |
| Sunrise — lab / cashier / pharmacy    | http://sunrise.localhost:3000  | `labtech@` / `cashier@` / `pharmacy@sunrise.test` |
| **District** (government, ₹0) — admin | http://district.localhost:3000 | `admin@district.test`                             |

(Sunrise & District, and all their staff, come from `pnpm seed:demo`.)

**There are two nurses on purpose.** The rule that stops one dose being given twice can only be
exercised by two people reaching for it at once, and one account signed in twice is one identity —
which is exactly what that test must not have.

---

## Three rules that stop 90% of the confusion

1. **The web address IS the hospital.** `sunrise.localhost` is Sunrise. A slug that was never created
   shows _"This address does not belong to any hospital"_ — that's the URL, not your password.
2. **Emails end in `.test`** (e.g. `admin@sunrise.test`), not `.com`.
3. **Seed once.** `pnpm dev` never wipes data. Re-seed only after you reset the database. Every
   command here is safe to run again.

---

## If a login still fails after a fresh create

The app briefly caches "no such hospital" for an address you visited before it existed. If you made a
hospital but its login still says it doesn't exist, **restart the app** (Ctrl-C the `pnpm dev`
terminal, then `pnpm dev`) to clear that cache, and try again.
