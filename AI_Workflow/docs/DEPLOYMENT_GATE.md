# The deployment gate — may this release roll out?

**Status:** live. `pnpm seed:migrate --check`. Enforced by `apps/api/src/deploymentGate.test.ts` and
`schemaGuard.int.test.ts` §5.

## The rule, in one line

> **A migration record is not evidence that the schema is right.** Only the database is.

## Where it sits

RELEASE_MANAGEMENT §5 gives the order for a schema-coupled release. The gate is the step between
the migration and the traffic:

```
build → run migrations (expand-only, §6) → ► CHECK ◄ → shift traffic → contract next release
```

It answers one question — _is every tenant on a schema this build can serve?_ — and it answers it
without changing anything. **It never migrates.** A check that mutates cannot be run twice and
cannot be trusted once, because the first run changes what the second one reports.

## The command

```bash
pnpm seed:migrate --check                     # human-readable, one line per tenant
pnpm seed:migrate --check --slug harmony      # one tenant
pnpm --silent seed:migrate --check --json     # one JSON document on stdout
```

`--silent` matters for `--json` and is not optional: without it pnpm prints its own banner to
stdout and the output is no longer parseable. With it, stdout holds exactly one document (the
logger is silenced in `--json` for the same reason).

## Exit semantics

| Exit | Verdict     | Meaning                                           | What a deploy step should do                                                 |
| ---- | ----------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `0`  | `READY`     | Every tenant was inspected and is correct.        | Roll out.                                                                    |
| `1`  | `NOT_READY` | A database was inspected and its schema is wrong. | **Stop.** Fix the schema, check again.                                       |
| `2`  | `ERROR`     | The question could not be answered.               | **Stop.** Retry or fix config — do _not_ conclude anything about the schema. |

The 1/2 split is the reason this exists. Before it, a tenant two migrations behind and a tenant
that was briefly unreachable both exited `1`, and both printed "run `migrate --all`" — an
instruction to migrate a database nobody could reach. Every operational hiccup looked exactly like
schema drift, which is how a gate acquires a `|| true` within a month.

**`ERROR` outranks `NOT_READY`.** If one tenant is behind and another was never reached, the honest
headline is not "the fleet is behind" — that would imply the unreachable one had been inspected and
found acceptable.

**The gate fails closed.** An unknown slug, an empty registry, and a malformed row are all `ERROR`,
never a pass. "Every tenant is ready" is vacuously true of zero tenants, and a release gate whose
happiest answer is _I found nothing to check_ is worse than no gate at all.

## Failure categories

| Code                   | Verdict    | What happened                                                           | Remedy                                                            |
| ---------------------- | ---------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `ready`                | READY      | Converged, and the clinical invariants are armed in the database.       | —                                                                 |
| `behind`               | NOT\_READY | Migrations outstanding, history otherwise sound.                        | `pnpm seed:migrate --slug <slug>` (or `--all`), then check again. |
| `preflight_blocked`    | NOT\_READY | Outstanding **and** the next migration refuses on the data there.       | Resolve what the migration reports, _then_ converge.              |
| `schema_drift`         | NOT\_READY | Every migration recorded; a required constraint is not in the database. | **Clear the record first**, then converge — see below.            |
| `history_inconsistent` | NOT\_READY | A history these migrations, run in order, could not have produced.      | **Do not converge.** Investigate where the history came from.     |
| `malformed`            | ERROR      | The registry row cannot say which database to open.                     | Fix the row in the master `tenants` collection.                   |
| `unreachable`          | ERROR      | The database could not be reached or inspected.                         | Restore access and re-check. Says **nothing** about the schema.   |

Three of these must not be given the obvious instruction, and that is most of the value here:

- **`schema_drift`** — `migrateTenantDb` skips any migration already recorded. Told to run
  `seed:migrate`, it reports "tenant converged" while changing nothing (measured on a real tenant,
  2026-08-14: `migrationsApplied: []`, index still absent). Clear the record for the named
  migration, then converge. Something dropped that index; a re-created one will not say what.
- **`history_inconsistent`** — converging would apply an outstanding migration _after_ one that has
  already run past it.
- **`preflight_blocked`** — it will simply refuse again. The data comes first.

## Ahead is not a failure

A tenant carrying migrations this build does not ship is **`ready`, with a note**. Expand → migrate
→ contract means the older code can serve the expanded schema, and RELEASE_MANAGEMENT §6 defines
rollback as redeploying the previous image against exactly this state. A gate that failed on it
would make every rollback impossible — the opposite of safe. It is reported because deploying a
build older than the fleet's schema is worth knowing, not because it is wrong.

This is also why the gate is compatible with a rolling deployment: it is a check on the tenant's
schema against the release's migration list, not a demand that the two be identical.

## What it does NOT do

- It does not migrate, seed, repair, or retry.
- It does not watch. It answers when asked — strictly weaker than the scraped gauge
  **RISK_REGISTER T2** asks for, and **T2 stays open**.
- It does not introspect every schema object. It checks the canonical migration history plus the
  named `CLINICAL_SAFETY_INVARIANTS` — the constraints a clinical rule actually rests on. That list
  is deliberately short and evidence-backed; a list that grows past its evidence stops being read.
- It does not block clinical writes at runtime. **That control now exists and is separate from
  this one** — `tenantSchemaReadiness` refuses the five capability-specific clinical writes with a
  503 and a `Retry-After` when the index they rest on is missing (HMS-MAR-002, HMS-PHM-004,
  HMS-ORD-001, HMS-ADM-003, HMS-ENC-001; see ERROR_CODES.md). The two answer different questions
  and neither replaces the other: this gate says _"do not roll out"_ before traffic moves, the
  runtime guard says _"chart on paper"_ to a clinician holding a phone when a database drifted
  after roll-out. A green gate does not disarm the runtime guard, and a firing runtime guard means
  this gate was either not run or not obeyed.

## The convergence procedure (RISK_REGISTER T2)

`--check` reports; it never repairs. Converging the fleet is two commands in this order, and the
second is not optional — the first tells you what it _did_, only the second tells you the fleet is
actually armed.

```bash
pnpm seed:migrate --all            # converge: migrations + idempotent seeds, per tenant
pnpm --silent seed:migrate --check --json > gate.json   # verify: exit 0 = READY
```

Why both:

- `--all` isolates failures deliberately — one hospital that fails must never halt the fleet — so
  it can exit non-zero having converged most tenants. "It ran" is not "it converged".
- `--all` reports the migrations it APPLIED. `--check` verifies the migration history _and_ the
  named `CLINICAL_SAFETY_INVARIANTS` are actually present, which is the property clinical writes
  rest on.
- A registry row too malformed to migrate is SKIPPED by `--all` (never repaired into a database
  called `undefined`) and sets a non-zero exit. Only `--check` will tell you it is still unfixed.

Exit codes are the contract: `0` READY · `1` NOT_READY · `2` ERROR (nothing is known — do not
converge on the strength of it). An empty fleet and a mistyped `--slug` both answer NOT a pass.

## When it must run

1. **Before any release that requires a new migration** — after migrations are applied, before
   traffic shifts. This is the gate's whole purpose.
2. **Before every manual-validation run.** A validation result taken against an unconverged tenant
   is void; `seed:validation` refuses to run against one for exactly this reason.

There is no automated deployment pipeline in this repository — `.github/workflows/ci.yml` is a
correctness gate (lint, typecheck, tests, build, boundaries) that builds and deploys nothing, and
it has never executed a step because the account is billing-locked. **So this is a command with a
documented call site, not a CI job.** Adding a workflow step that runs it would be theatre: it
would have no fleet to check, because CI has no tenants.

When a deployment path does exist, the integration is:

```bash
pnpm --silent seed:migrate --check --json > gate.json
case $? in
  0) : ;;                                    # roll out
  1) echo "schema not ready"; exit 1 ;;      # stop; a human fixes the schema
  2) echo "check did not complete"; exit 1 ;; # stop; retry or fix config
esac
```

## Scale

Four tenants today, checked sequentially in ~20 ms. `checkTenant` is independent per tenant and
returns a value rather than mutating shared state, so bounded concurrency is a `map` with a
semaphore on the day the fleet is large enough to want one. It is not worth buying now.
