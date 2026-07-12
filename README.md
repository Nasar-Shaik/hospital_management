# MediCore HMS — Monorepo

PaperlessTech Hospital Management SaaS. **Platform foundation + multi-tenancy + authentication** are live (Phases 0, 1A, 1B); business modules arrive per the phase plan.

> **Before writing any code**, read (in order): [AI_Workflow/PROJECT_MEMORY.md](./AI_Workflow/PROJECT_MEMORY.md) → [AI_Workflow/PROJECT_CONSTITUTION.md](./AI_Workflow/PROJECT_CONSTITUTION.md) → [AI_Workflow/PlanofActionforHMS/00-PROGRESS-TRACKER.md](./AI_Workflow/PlanofActionforHMS/00-PROGRESS-TRACKER.md). Architecture: [04-ARCHITECTURE.md](./AI_Workflow/PlanofActionforHMS/04-ARCHITECTURE.md). Standards: [09-ENGINEERING-STANDARDS.md](./AI_Workflow/PlanofActionforHMS/09-ENGINEERING-STANDARDS.md). Governance docs and ADRs live in [AI_Workflow/docs/](./AI_Workflow/docs/).
>
> All project artifacts — code, architecture, governance, ADRs — live in **this single repository**, which is the sole source of truth.

## Layout (Doc 04 §1)

```
apps/
  api/      Express REST API (the ONLY backend API) — :4000
  workers/  BullMQ background jobs — health :4100
  web/      Next.js App Router (public + portal + operator) — :3000
  admin/    Next.js super-admin console — :3001
packages/
  config/       shared tsconfig / eslint / prettier
  logger/       pino JSON logger with PHI redaction
  types/        shared domain-neutral types (API envelope, health)
  validation/   shared Zod schemas (DTO source of truth)
  utils/        dependency-free helpers (money = integer minor units)
  permissions/  permission catalog scaffolding
  api-client/   isomorphic typed API client (the only data path for web)
  ui/           design tokens (Doc 08); components land in P1
infra/docker/   dev compose (mongo RS, redis, minio, mailhog)
```

## Prerequisites

Node ≥ 22 · pnpm 10 (`npm i -g pnpm@10`) · Docker

> **New here, or unsure which port to hit?** Read **[TESTING.md](./TESTING.md)** — it covers what runs where, how to create a hospital, and a copy-paste script for the whole auth flow. Note that `pnpm docker:dev` starts only the _infrastructure_; `pnpm dev` starts the apps.

## Quick start

```bash
pnpm install                 # install workspace
pnpm docker:dev              # start infra (mongo, redis, minio, mailhog)

cp apps/api/.env.example apps/api/.env
cp apps/workers/.env.example apps/workers/.env
cp apps/web/.env.example apps/web/.env
cp apps/admin/.env.example apps/admin/.env

pnpm dev                     # all apps with hot reload (turbo)
```

| Service                | URL                                                        |
| ---------------------- | ---------------------------------------------------------- |
| API health / readiness | http://localhost:4000/health · http://localhost:4000/ready |
| Workers health         | http://localhost:4100/health                               |
| Web (tenant app)       | http://localhost:3000 (health: /api/health)                |
| Admin console          | http://localhost:3001 (health: /api/health)                |
| Mailhog UI             | http://localhost:8025                                      |
| MinIO console          | http://localhost:9001 (minioadmin/minioadmin)              |

## Multi-tenancy (Phase 1A — live)

Master DB `paperlesstech_master` + **one dedicated database per hospital** (`hms_<slug>`), resolved per request from the `Host` header (ADR-0005, Doc 03 §1).

Provision a hospital (operator action — there is deliberately no unauthenticated provisioning route):

```bash
pnpm --filter @medicore/api provision -- --name "Apollo Hospital" --slug apollo \
     --plan PLAN_CLINIC --admin-email admin@apollo.com
# → creates database hms_apollo, runs migrations, seeds system roles + the first
#   admin, activates the tenant, and prints the one-time password
```

Every `/api/v1/*` request is resolved to exactly one hospital database before any handler runs:

```bash
curl -H "Host: apollo.paperlesstech.in" localhost:4000/api/v1/...   # → tenant resolved
curl -H "Host: ghost.paperlesstech.in" localhost:4000/api/v1/...   # → HMS-TEN-001 Organization not found
curl localhost:4000/health                                          # → health needs no tenant
```

Custom domains work the same way once verified in the registry. `/health` and `/ready` sit **before** tenant resolution — probes must never depend on the registry.

## Authentication (Phase 1B — live)

**The host selects the database; the token proves the user; the two must agree.** A valid token for Apollo, replayed against Sunshine's host, is rejected with `HMS-TEN-003` even though its signature is perfectly good (ADR-0009).

```bash
H='Host: apollo.paperlesstech.in'
curl -X POST localhost:4000/api/v1/auth/login -H "$H" -H 'Content-Type: application/json' \
     -d '{"email":"admin@apollo.com","password":"…"}'      # → accessToken + rotating refreshToken
curl localhost:4000/api/v1/auth/me -H "$H" -H "Authorization: Bearer $ACCESS"
```

| Endpoint                                                    | Auth          | Notes                                                     |
| ----------------------------------------------------------- | ------------- | --------------------------------------------------------- |
| `POST /auth/login`                                          | public        | Returns tokens, or an MFA challenge if MFA is on          |
| `POST /auth/refresh`                                        | refresh token | **Rotates**; replaying a spent token kills the family     |
| `POST /auth/mfa/verify`                                     | MFA challenge | Completes a login; accepts a TOTP or a recovery code      |
| `POST /auth/logout` · `GET /auth/me` · `GET /auth/sessions` | access token  | Logout blocklists the access token and revokes the family |
| `DELETE /auth/sessions/:id` · `POST /auth/change-password`  | access token  | Sign out one device; a password change ends every session |
| `POST /auth/mfa/setup` · `/mfa/activate` · `/mfa/disable`   | access token  | TOTP; MFA is not active until a code is proven            |

Passwords are argon2id. Refresh tokens are stored only as SHA-256 digests. TOTP seeds are AES-256-GCM encrypted at rest. Login is not a user-enumeration oracle: unknown email, wrong password, disabled and locked accounts all return an identical `HMS-AUTH-001`.

`API_JWT_SECRET` and `API_ENCRYPTION_KEY` are **required** — the API refuses to boot without them, deliberately (a default signing secret is how a dev key reaches production). Generate with `openssl rand -base64 48` and `openssl rand -base64 32`.

## Verification

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # full quality gate
pnpm boundaries                                          # module boundary lint
pnpm --filter @medicore/api test:int                     # ISOLATION + AUTH suites (needs pnpm docker:dev)
curl -s localhost:4000/health | jq                       # liveness
curl -s localhost:4000/ready | jq                        # readiness (deps)
```

The integration suites (46 tests: 17 tenant-isolation, 29 auth) run against a **real** MongoDB and Redis and **fail rather than skip** when either is unreachable. That is not fussiness: a silently skipped isolation suite is indistinguishable from a passing one, and because cache helpers fail soft, the token-revocation assertions would pass vacuously with no Redis running.

Fully containerized run (builds all four app images):

```bash
docker compose -f infra/docker/docker-compose.yml --profile apps up --build
```

## Rules that CI enforces

Conventional commits (commitlint) · Prettier + ESLint (strict TS, no `any`, no `console`) · typecheck · unit tests · **tenant-isolation + authentication integration suites** (real Mongo + Redis services) · dependency-cruiser boundaries (acyclic graph; modules only via `index.ts`; frontends never import backend; packages never import apps).

## What the codebase deliberately does NOT contain yet

RBAC enforcement (Phase 1C — roles exist and ride in the token, but the `authorize` middleware and permission catalog do not), forgot/reset-password (needs the notification channel from A6 — a reset flow that cannot deliver a reset is worse than none), SSO and passkeys (Enterprise edition), and all business modules (P2+). Do not add them without following the module spec (Doc 02) and updating [00-PROGRESS-TRACKER.md](./AI_Workflow/PlanofActionforHMS/00-PROGRESS-TRACKER.md).
