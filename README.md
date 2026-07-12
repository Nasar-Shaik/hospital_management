# MediCore HMS — Monorepo

PaperlessTech Hospital Management SaaS. **Sprint 0 bootstrap** — platform foundation only; business modules arrive per the phase plan.

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

## Verification

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # full quality gate
pnpm boundaries                                          # module boundary lint
curl -s localhost:4000/health | jq                       # liveness
curl -s localhost:4000/ready | jq                        # readiness (deps)
```

Fully containerized run (builds all four app images):

```bash
docker compose -f infra/docker/docker-compose.yml --profile apps up --build
```

## Rules that CI enforces

Conventional commits (commitlint) · Prettier + ESLint (strict TS, no `any`, no `console`) · typecheck · unit tests · dependency-cruiser boundaries (acyclic graph; modules only via `index.ts`; frontends never import backend; packages never import apps).

## What Sprint 0 deliberately does NOT contain

Authentication, tenancy/Connection Manager, business modules, database models — these are **Phase 1** (Doc 01). Do not add them without following the module spec and updating the progress tracker.
