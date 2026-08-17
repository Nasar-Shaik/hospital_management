# VPS DEPLOYMENT READINESS — V1 PILOT

**Status:** assessment only. Nothing here has been deployed, and this document does not redesign
the architecture — it audits the deployment path that already exists against what a single-VPS
pilot actually needs.

**Scope.** HMS runs on its own dedicated VPS. The co-hosting plan was abandoned, so nothing below
considers a shared host.

> **Read this next to [`DISASTER_RECOVERY_RUNBOOK.md`](DISASTER_RECOVERY_RUNBOOK.md) §0**, which
> covers backup and restore concretely and is the other half of pilot operational readiness.

---

## 1. What is already right

Worth stating first, because the gaps below are narrower than a blank page would suggest. None of
this needed changing:

| Area                          | Evidence                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Container images**          | Dockerfiles exist for all four apps (`api`, `web`, `admin`, `workers`) and build under the compose `apps` profile.          |
| **Health / readiness**        | `GET /health` and `GET /ready` are mounted (`core/health/health.router.ts`) — a proxy has something to poll.                |
| **Reverse-proxy shape**       | `app.set("trust proxy", true)` is already set, with a comment naming the Nginx/Traefik topology.                            |
| **Bind address**              | Production defaults the API to **loopback**, so a misconfigured firewall cannot expose Express directly. Containers opt in. |
| **Secrets refuse to default** | `API_JWT_SECRET` (≥32) and `API_ENCRYPTION_KEY` (≥32) have **no defaults**. A production boot without them fails.           |
| **Security invariants**       | `config/profiles.ts` **throws** rather than warns when production tries to weaken `PASSWORD_MIN_LENGTH` and friends.        |
| **HTTP hardening**            | `helmet()` and an explicit CORS allow-list, applied before routing.                                                         |
| **Schema gate**               | `pnpm seed:migrate --check` gives a deploy step a machine-readable verdict with real exit codes.                            |
| **Runtime schema guard**      | Five clinical writes refuse with 503 + `Retry-After` if the database drifts after roll-out.                                 |
| **Backup completeness**       | Every clinical file is a BSON `Buffer`, so one `mongodump` is a complete backup. No object store to keep in step.           |

---

## 2. Findings

### P1 — must be resolved before the pilot serves a real patient

**P1-1 · Wildcard DNS and wildcard TLS are undocumented, and tenancy depends on them.**
ADR-0005 makes the **hostname the tenant**: `resolveTenant` reads the `Host` header, and
`TENANT_BASE_DOMAIN` produces `*.<domain>`. A pilot therefore needs a wildcard `A` record **and** a
wildcard certificate, or the second hospital cannot be reached at all. Nothing in the repository
says this. It is the single most likely way a deployment day is lost.
_Not a code change — a deployment prerequisite that must be written down and provisioned._

**P1-2 · There is no production compose file, only a dev one.**
`infra/docker/docker-compose.yml` opens with "Dev environment". It publishes Mongo and Redis on
`127.0.0.1` (right for a laptop), ships **MinIO and Mailhog** (neither used in production — MinIO
is never called by the API at all), and supplies **local default secrets** for `API_JWT_SECRET` and
`API_ENCRYPTION_KEY`. Deploying it as-is would run a pilot on a known JWT signing key.
_Needs a separate production compose (or an override file) — not a redesign, a second file._

**P1-3 · No container has a `restart:` policy.**
Zero occurrences in the compose file. A VPS reboot, an OOM kill, or a crash leaves the hospital
down until a human notices. The DR runbook's "PM2 auto-restarts" (§3) describes a supervisor this
repository does not configure.

### P2 — should be resolved before general release

**P2-1 · No reverse-proxy configuration is committed.** The app is _written_ for one
(`trust proxy`, loopback bind) and none is provided, so TLS termination, HTTP→HTTPS redirect and
the wildcard host routing are all improvised on the day.

**P2-2 · No log rotation or shipping.** Pino writes to stdout; Docker's default json-file driver
grows without bound. On a single VPS that ends as a full disk, which takes the database with it.
_2026-08-17 P2 review: **the only item on this list that fails without anybody touching it.** Two
lines of daemon config — do it alongside P1-2's production compose rather than scheduling it._

**P2-3 · Backup is entirely manual.** DR §0 is executable and has been run once, but there is no
cron, no rotation, no retention and no off-site copy. **RPO is the age of the last dump.**

**P2-4 · Observability is documentation, not code.** `OBSERVABILITY_GUIDE.md` and DR §1–7 name
metrics and alerts (`hms_migration_pending`, `redis_up`, `hms_payment_failures_total`) that do not
exist — there is no `prom-client`, no `/metrics`, no alerting. Risk-register **T2** stays open for
this reason. An operator following DR §1–7 during an incident would look for dashboards that are
not there; the banner added to that file now says so.

### P3 — worth doing, not blocking

**P3-1 · No documented rollback.** The forward path is `--all` then `--check`; going back is
"restore from dump" (DR §0.3), which is correct but slow and unstated as a rollback.
**P3-2 · No resource limits** on containers, so one runaway process can take the box.
**P3-3 · Mongo runs as a single-node replica set.** Correct for transactions, but it is one disk —
consistent with a pilot, worth naming as accepted risk rather than discovering later.

### DOCUMENTATION

- **DOC-1** DR runbook §1–7 describe target infrastructure. **Fixed 2026-08-17** — a banner now
  marks them as design and points to the concrete §0.
- **DOC-2** No single "deploy the pilot" page. The pieces exist across compose, env, the gate and
  DR §0; nobody has written the order.
- **DOC-3** `LOCAL_PORTS.md` documents dev ports only, which is correct but reads as complete.

### PRODUCT

- **PROD-1** Is a **single VPS with one Mongo node** acceptable for the pilot's data-durability
  promise? That is a commercial commitment (SLA, contractual RPO), not an engineering call. The
  NFR at the top of the DR runbook claims **RPO ≤ 5 min**, and the procedure that exists cannot
  deliver it. Either the target moves or PITR gets built.
- **PROD-2** Which hospitals are in the pilot, and does any of them require data residency? §4 of
  the DR runbook assumes region pinning exists as a contractual carve-out.

### FUTURE

CI-driven deployment (billing-locked, see `DEPLOYMENT_GATE.md`), multi-region DR, an orchestrator
with HPA, PITR, the Prometheus/Grafana layer (P9), and automated daily restore-tests. **None of
these is a V1 blocker** and none should be started for the pilot.

---

## 3. What this means for the pilot

**No P0.** The application is deployable; the gaps are in the environment around it, and three of
them (P1-1…P1-3) are provisioning and configuration rather than engineering.

The honest summary: **the software is ready to be validated by hand before this list is closed, and
must not serve a real patient until P1-1, P1-2 and P1-3 are.** Manual validation runs against the
dev environment on a developer machine, so nothing here blocks it.
