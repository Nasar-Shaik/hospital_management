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

Two commands give you everything — the console admin, two ready-made hospitals with all staff,
prices and drugs, and a set of demo patients:

```bash
pnpm seed:demo
pnpm seed:clinical
```

Then sign in (see **Logins** at the bottom). That's it — you don't need anything else below.

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
| Sunrise — lab / cashier / pharmacy    | http://sunrise.localhost:3000  | `labtech@` / `cashier@` / `pharmacy@sunrise.test` |
| **District** (government, ₹0) — admin | http://district.localhost:3000 | `admin@district.test`                             |

(Sunrise & District, and all their staff, come from `pnpm seed:demo`.)

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
