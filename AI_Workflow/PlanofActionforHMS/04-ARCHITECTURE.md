# 04 — System Architecture

Folder structures, backend/frontend/React Native architecture, API design, repository layout, Docker and CI/CD.

---

## 1. Repository Strategy — Monorepo

A single **pnpm workspace + Turborepo** monorepo maximizes code sharing (types, validation schemas, API client, UI primitives) across web, mobile, backend and admin.

```
medicore-hms/
├── apps/
│   ├── api/                 # Express backend (REST + WebSocket) — the ONLY API
│   ├── web/                 # Next.js (App Router) — public sites, patient portal, operator app
│   ├── admin/               # Next.js super-admin console
│   ├── patient-app/         # React Native (Expo)
│   ├── doctor-app/          # React Native (Expo)
│   ├── staff-app/           # React Native (Expo)
│   └── workers/             # BullMQ workers (notifications, reports, OCR, billing jobs)
├── packages/
│   ├── types/               # Shared TS domain types & DTOs
│   ├── validation/          # Zod schemas (shared FE/BE)
│   ├── api-client/          # Typed API SDK (used by web/admin/mobile)
│   ├── ui/                  # Shared Shadcn-based component library (web)
│   ├── config/              # eslint, tsconfig, tailwind presets
│   ├── permissions/         # Permission catalog + guards (shared)
│   ├── i18n/                # Locale bundles
│   └── utils/               # Date, money, formatting, phone, medical helpers
├── infra/
│   ├── docker/              # Dockerfiles, compose
│   ├── k8s/                 # Helm charts / manifests (prod)
│   ├── terraform/           # IaC (cloud, DB, storage, DNS)
│   └── nginx/               # Gateway configs
├── docs/                    # OpenAPI, ADRs, runbooks
├── .github/workflows/       # CI/CD pipelines
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

---

## 2. Backend Architecture (Express + TypeScript)

### 2.1 Layered design

```
Request → Gateway (Nginx) → Express
  → Middleware chain:
      requestId → helmet/cors → rateLimit → bodyParse
      → resolveTenant (subdomain/custom-domain → master DB registry,
        Redis-cached → Connection Manager → tenant DB connection in ALS)
      → authenticate (JWT; claim tenantId MUST match resolved tenant)
      → authorize (RBAC + permission + scope)
      → validate (Zod) → idempotency
  → Controller (thin: parse, delegate, shape response)
      → Service (business logic, transactions, orchestration)
          → Repository (Mongoose, tenant-scoped queries)
          → Integration clients (payment, SMS, HL7, LLM)
          → Event publisher (outbox → queue)
  → Response envelope + error handler
```

### 2.2 `apps/api` structure

```
apps/api/src/
├── main.ts                       # bootstrap, server, socket, graceful shutdown
├── app.ts                        # express app assembly
├── config/                       # env (zod-validated), constants
├── core/
│   ├── context/                  # AsyncLocalStorage tenant/user context
│   ├── db/                       # masterDb client, ConnectionManager (per-tenant DB), reference DB
│   ├── redis/                    # redis client, pub/sub
│   ├── errors/                   # AppError hierarchy, error codes
│   ├── logger/                   # pino/OTel logger
│   ├── events/                   # outbox, event bus, domain events
│   └── plugins/                  # tenantScopePlugin, auditPlugin, softDeletePlugin
├── middleware/                   # auth, authorize, validate, rateLimit, idempotency
├── modules/                      # one folder per module (feature-sliced)
│   ├── auth/
│   │   ├── auth.routes.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── auth.repository.ts
│   │   ├── auth.schema.ts        # zod
│   │   └── auth.model.ts         # mongoose
│   ├── tenants/  subscriptions/  rbac/  users/
│   ├── patients/  appointments/  doctors/  beds/
│   ├── emr/  nursing/  lab/  radiology/  ot/  bloodbank/  pharmacy/
│   ├── billing/  insurance/  inventory/  finance/  hr/
│   ├── notifications/  communication/  files/
│   ├── reports/  dashboards/
│   ├── ai/  integrations/
│   └── security/
├── realtime/                     # socket.io gateways (namespaces per domain)
├── jobs/                         # queue producers
├── integrations/                 # payment, sms, email, whatsapp, hl7/fhir, dicom, llm
├── openapi/                      # generated spec
└── seed/                         # permissions, roles, reference data
```

### 2.2.1 Connection Manager (database-per-tenant core)

```ts
// core/db/connectionManager.ts (sketch)
class ConnectionManager {
  private pool = new Map<string, { conn: Connection; lastUsed: number }>(); // key: tenantId

  async forTenant(tenant: TenantRegistry): Promise<Connection> {
    const hit = this.pool.get(tenant.id);
    if (hit) {
      hit.lastUsed = Date.now();
      return hit.conn;
    }
    const base = tenant.dbUri ?? config.SHARED_CLUSTER_URI; // dedicated cluster override
    const conn = mongoose.createConnection(base).useDb(tenant.databaseName, { useCache: true });
    this.pool.set(tenant.id, { conn, lastUsed: Date.now() });
    return conn;
  }
  // LRU eviction of idle connections (idleMs, maxConnections) via interval sweep;
  // same-cluster tenants share the underlying socket pool through useDb.
}
```

**Resolution flow (per request):**

1. `Host` header → slug (`apollo.paperlesstech.in`) or custom-domain lookup (`hms.apollohospital.com`).
2. Tenant registry fetched from Redis (`tenant:{slug}` / `tenant:domain:{host}`, TTL 5 min) → miss falls through to `paperlesstech_master.tenants`.
3. Status gate (active/trial only) → Connection Manager → connection placed in AsyncLocalStorage.
4. JWT verified; `jwt.tenantId !== resolved tenant` → 403. Repositories/models bind exclusively to the ALS connection — **there is no global tenant-data connection to leak through**.

Master DB access is confined to `core/db/masterDb.ts` + the platform modules (tenants, subscriptions, feature flags, licensing, SaaS billing, support); business modules can only see the tenant connection.

### 2.3 Cross-cutting conventions

- **Response envelope:** `{ success, data, meta?, error? }`; errors carry `code`, `message`, `details`, `traceId`.
- **Validation:** Zod schemas shared with frontend via `packages/validation`.
- **Pagination:** cursor or page/limit; list metadata in `meta`.
- **Config:** all env vars validated at boot via Zod; fail fast.
- **Secrets:** from vault/secret manager, never in code.
- **Graceful shutdown:** drain HTTP, close sockets, finish in-flight jobs, close DB/Redis.

### 2.4 Module Boundary Rules (10-year maintainability)

The backend is a **modular monolith**; the boundary discipline is what keeps it maintainable and extractable:

1. A module may depend on another module **only** via (a) that module's exported **service interface** (`modules/<name>/index.ts` re-exports service + types only) or (b) **domain events** through the outbox. Direct imports of another module's repository, model, or internal files are **forbidden**.
2. Enforced in CI: ESLint `import/no-restricted-paths` (or dependency-cruiser) fails the build on boundary violations; the dependency graph must stay acyclic.
3. Shared logic goes to `packages/*` or `core/*` — never module-to-module copy-paste or reach-ins.
4. **Module = future service boundary.** If a module must be extracted at enterprise scale (candidates: notifications, reports/exports, integrations, AI workers), its service interface becomes the RPC contract and its outbox events already decouple consumers — extraction without rewriting callers.
5. Every module declares its feature-flag key (`module.<domain>.<name>`); route registration is skipped when the flag is off, so disabled modules cost nothing at runtime.

### 2.5 Realtime (Socket.IO)

- Namespaces: `/notifications`, `/queue`, `/chat`, `/monitoring`, `/beds`.
- Rooms are tenant/branch/user scoped: `t:{tenantId}:b:{branchId}:...`.
- Redis adapter for horizontal scaling; JWT auth on connection; same RBAC checks as REST.

### 2.6 Background processing (`apps/workers`, BullMQ)

Queues: `notifications`, `reports`, `exports`, `ocr`, `voice`, `billing`, `imports`, `webhooks`, `ai`, `reminders`, `integrations-outbound`. Each with retry/backoff, dead-letter queue, concurrency limits, and idempotent handlers.

---

## 3. Frontend Architecture (Next.js App Router + React 19) — ADR-0012

### 3.0 Architectural boundaries (normative)

| Tier         | Technology                                             | Owns                                                                               | Never does                                                                    |
| ------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Frontend** | Next.js (App Router) + React 19 + Tailwind + Shadcn UI | Rendering, routing, layouts, route guarding (middleware), white-label theming, SEO | Business logic, DB/Redis access, business API routes, authorization decisions |
| **Backend**  | Node.js + Express (modular monolith)                   | All APIs, authN/Z authority, tenancy resolution, business rules, data              | Rendering HTML                                                                |
| **Workers**  | BullMQ                                                 | Async jobs, events, scheduled work                                                 | Serving requests                                                              |
| **Realtime** | Socket.IO (+ Redis adapter)                            | Server push (boards, chat, notifications)                                          | Being a source of truth                                                       |
| **Mobile**   | React Native (Expo)                                    | Patient/doctor/staff native apps, offline                                          | —                                                                             |

Next.js is **presentation-tier only**. Its server side may render, guard, and handle the auth-cookie exchange — nothing else. `app/api/*` business routes are forbidden (boundary-linted); all data flows through `packages/api-client` → Express.

### 3.1 Stack

Next.js (App Router) + React 19 + TypeScript + Tailwind + Shadcn UI + TanStack Query (client server-state) + Zustand (client/UI state) + React Hook Form + Zod + `packages/api-client` (isomorphic: server components and client components both call Express through it).

### 3.2 `apps/web` structure (route groups × feature slices)

```
apps/web/
├── middleware.ts            # Host → tenant branding resolution (white-label), auth route guards
├── app/
│   ├── (public)/            # SSR/ISR — SEO surfaces, per-tenant themed via middleware
│   │   ├── page.tsx         # hospital public site / landing
│   │   ├── book/            # online appointment booking
│   │   └── doctors/         # public doctor directory
│   ├── (portal)/            # patient portal (auth: patient identity)
│   │   ├── layout.tsx       # portal shell
│   │   └── records/ appointments/ bills/ teleconsult/ ...
│   ├── (app)/               # operator dashboard (auth: staff) — client-component-heavy
│   │   ├── layout.tsx       # AppShell (nav by permissions + flags)
│   │   └── patients/ appointments/ emr/ nursing/ lab/ radiology/
│   │       ot/ pharmacy/ billing/ insurance/ inventory/ finance/
│   │       hr/ beds/ facilities/ masters/ reports/ ai/ settings/
│   └── layout.tsx           # root: tokens, providers (query, theme, i18n)
├── src/
│   ├── features/            # feature slices (components/ hooks/ api.ts types.ts) — pages in app/ stay thin and import from here
│   ├── components/          # ui/ (Shadcn) + shared/ (DataTable, FormFields, PermissionGate…)
│   ├── hooks/               # useAuth, usePermissions, useTenant, useSocket, usePaginatedQuery
│   ├── lib/                 # api client wiring, socket, formatters
│   └── config/              # env (NEXT_PUBLIC_* only for client), flags client, permission map
└── next.config.ts           # output: 'standalone'
```

### 3.3 Rendering & data rules

- **Server components (default):** public pages, portal read views, layout shells — fetch via `api-client` server-side (faster first paint, smaller bundles). Public tenant sites use **ISR** keyed by host (hundreds of white-label sites from one deployment).
- **Client components (`"use client"`):** everything interactive — the operator dashboard works exactly like the previous SPA (TanStack Query, optimistic updates for queue/MAR/vitals, sockets).
- **Middleware:** resolves `Host` → tenant branding/theme (edge-cached via API) and guards route groups by auth cookie presence. **Authorization remains Express's job** — middleware redirects, it never decides.
- **Auth:** access token in memory (client), refresh token in httpOnly SameSite cookie; middleware checks cookie presence; token verification/refresh happens against Express only.
- **PermissionGate / FeatureGate**, **DataTable**, RHF+Zod forms, CSS-variable theming, entitlement-aligned code splitting — all unchanged from the SPA design.

### 3.4 Admin console (`apps/admin`)

Smaller Next.js app, super-admin only (tenant provisioning, plans, flags, monitoring, impersonation, SaaS billing). No public route group; all client-component dashboard patterns.

### 3.5 Where Vite remains

Vite is no longer an application framework here. It survives only as tooling: **Vitest** (unit test runner, Vite-powered) and the **`packages/ui` component playground/Storybook builder**. Do not scaffold app features with Vite.

---

## 4. React Native Architecture (Expo)

Three apps (patient, doctor, staff) share a `packages/mobile-core`.

```
apps/patient-app/  (doctor-app, staff-app analogous)
├── app/                    # expo-router file-based routes
│   ├── (auth)/  (tabs)/  [modals]/
├── src/
│   ├── api/                # shared api-client + react-query hooks
│   ├── components/         # RN UI kit (tokens matching web brand)
│   ├── features/           # appointments, records, billing, chat, teleconsult...
│   ├── store/              # zustand + MMKV persistence
│   ├── offline/            # queue + sync engine (mutations replay)
│   ├── notifications/      # expo-notifications (FCM/APNS)
│   ├── auth/               # secure token store (expo-secure-store), biometric
│   └── lib/                # socket, formatters, permissions
└── app.config.ts           # per-tenant/white-label build config
```

**Key mobile concerns**

- **Offline-first** (staff/doctor): local cache (MMKV/SQLite) + mutation queue with conflict resolution; sync on reconnect.
- **Push**: Expo Notifications → FCM/APNS; deep links to screens.
- **Realtime**: Socket.IO client for queue/chat/monitoring.
- **Security**: secure token storage, biometric unlock, certificate pinning, jailbreak/root detection, screen-capture protection for PHI.
- **Teleconsult/video**: WebRTC via provider SDK.
- **White-label**: `app.config.ts` + EAS build profiles per reseller (icon, name, theme, API base).

---

## 5. API Design

### 5.1 Conventions

- Base: `/api/v1`; versioned; OpenAPI 3.1 generated from Zod (`zod-to-openapi`).
- **Tenant resolution first, auth second:** subdomain (`<slug>.paperlesstech.in`) or custom domain (`hms.apollohospital.com`) → master-registry lookup (Redis-cached) → tenant DB connection via Connection Manager (§2.2.1). The JWT `tenantId` claim must match the host-resolved tenant or the request is rejected (403) — the host header selects the database but is never the authorization authority.
- Branch via `X-Branch-Id` header (validated against user scope).
- Wildcard TLS for `*.paperlesstech.in`; custom domains get automated certificates (ACME/cert-manager) after DNS verification.
- **Versioning & deprecation policy:** within `/v1`, changes are **additive only** (new fields/endpoints; never remove/rename/retype). Breaking changes ship as `/v2` side-by-side; deprecated endpoints emit `Deprecation` + `Sunset` headers with a **12-month** minimum sunset window; API keys can pin a version. This is the backward-compatibility contract for the public API and all mobile apps (old app builds in the field must keep working).
- Auth: `Authorization: Bearer <access>`; refresh via rotating tokens with reuse detection.
- Idempotency: `Idempotency-Key` header on POST for money/critical ops.
- Standard query params: `page,limit,sort,q,filter[field],from,to,include`.
- Rate limits per tenant/user/API-key; `429` with `Retry-After`.
- Errors: RFC-7807-style problem envelope + internal error codes.
- Webhooks: signed (HMAC), retried, with delivery log.

### 5.2 Resource map (top-level)

```
/auth  /tenants  /plans  /subscriptions  /feature-flags  /usage
/roles  /permissions  /users  /invitations  /api-keys  /audit-logs
/branches  /departments  /buildings  /floors  /wards  /rooms  /beds
/ot  /icu  /er  /ambulances  /equipment  /assets  /maintenance
/insurance-companies  /corporate-clients  /vendors  /suppliers  /services  /tariffs
/patients  /admissions  /visits  /appointments  /queues  /tokens  /waiting-list
/doctors  /specializations  /doctor-schedules
/emr  /soap-notes  /diagnoses  /icd  /procedures  /allergies  /vitals
/consultations  /prescriptions  /orders  /referrals  /transfers  /consents
/nursing-notes  /mar  /care-plans  /handovers
/lab-tests  /lab-orders  /samples  /lab-results
/radiology-orders  /radiology-reports  /dicom
/ot-bookings  /pre-op  /intra-op  /post-op
/blood-donors  /blood-inventory  /cross-matches  /blood-issues  /transfusions
/bills  /payments  /refunds  /advances  /invoices  /discounts
/pre-auth  /claims  /packages  /wallets  /corporate-ledgers
/medicines  /pharmacy/*  /inventory/*  /indents  /purchase-orders  /grn  /stock/*
/accounts  /journal-entries  /ledgers  /expenses  /incomes  /reports/finance/*
/employees  /attendance  /leaves  /payroll  /payslips  /shifts
/notifications  /chat  /announcements  /files
/reports  /dashboards  /kpis
/ai/*  /integrations  /webhooks  /hl7  /fhir  /abdm
/security  /backups  /dsr  /incidents  /health  /ready  /metrics
```

---

## 6. Docker Structure

### 6.1 Dev — `infra/docker/docker-compose.yml`

Services: `api`, `workers`, `web`, `admin`, `mongo` (replica set for transactions/change streams), `redis`, `minio` (S3), `mailhog`, `mongo-express`, optional `orthanc` (DICOM). Hot-reload via bind mounts.

### 6.2 Production images

- Multi-stage Dockerfiles (builder → slim runtime, non-root user, distroless/alpine).
- Separate images: `api`, `workers`, `web` (**Next.js `output: 'standalone'` → Node runtime**), `admin` (same).
- `web`/`admin` containers run `node server.js` (standalone output), expose `/api/health` for probes, sit behind the gateway/CDN; static assets (`.next/static`, images) served via CDN with immutable cache headers.
- Env split: server-side secrets never use `NEXT_PUBLIC_`; client-visible config only via `NEXT_PUBLIC_*` (validated at build); API base URL is per-environment config.
- Health/readiness endpoints wired to orchestrator probes on all four images.

```dockerfile
# apps/api/Dockerfile (sketch)
FROM node:22-alpine AS builder
WORKDIR /app
COPY pnpm-lock.yaml package.json ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter api build
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
```

### 6.3 Deployment targets

- **Small tenants / single-VM:** Docker Compose + **PM2** (cluster mode for API, separate PM2 apps for workers **and the Next.js standalone servers**) behind Nginx. The frontend is a Node process now (ADR-0012 trade-off) — the same runtime the API already requires, so on-prem stays a one-runtime box.
- **Scale / Enterprise:** **Kubernetes** (Helm), HPA autoscaling on API, workers **and web/admin deployments**, managed MongoDB (Atlas) + Redis, object storage, CDN (Next static assets + ISR cache), WAF.
- **White-label domains:** wildcard + custom-domain TLS terminates at the gateway; both Express (API) and Next.js middleware (rendering/theming) resolve tenant from `Host` against the same master registry — one resolution model, two consumers.

---

## 7. CI/CD Pipeline (GitHub Actions)

```
PR opened / push
 ├─ lint & typecheck (turbo, affected only)
 ├─ unit tests (vitest/jest) + coverage gate
 ├─ integration tests (mongo+redis service containers)
 ├─ build all affected apps/packages
 ├─ security: pnpm audit, Trivy (images), SAST (CodeQL/Semgrep), secret scan (gitleaks)
 ├─ e2e (Playwright web, Detox mobile smoke) on staging build
 └─ SBOM generation
     ↓ (on merge to main)
 ├─ build & push images (GHCR/ECR) tagged by SHA + semver
 ├─ deploy to STAGING (auto) → smoke tests → DB migration check
 ├─ manual approval gate
 ├─ deploy to PRODUCTION (blue-green / canary)
 ├─ run migrations (guarded, reversible)
 ├─ post-deploy health checks + synthetic monitors
 └─ notify (Slack) + create release record
```

**Environments:** `dev` → `staging` → `production`, each isolated (DB, Redis, storage, secrets). Mobile: **EAS Build** + OTA updates (Expo Updates) with staged rollout; store submission via EAS Submit.

**Migrations (database-per-tenant):** versioned migration runner (`migrate-mongo` style) executed as a pre-deploy job that **iterates every tenant database from the master registry** (plus `paperlesstech_master` and `paperlesstech_reference` with their own migration sets). Each tenant DB tracks its own `migrations` collection, so a newly provisioned or restored tenant converges automatically; runs are parallelized with a concurrency cap, idempotent, and re-runnable — a failure on one tenant DB halts only that tenant (flagged for operator retry), never the fleet. Every migration has `up`/`down`; index builds run in background/rolling.

**Tenant provisioning pipeline:** create registry entry in master → create `hms_<slug>` database → run all migrations → seed roles/permissions/reference overrides → issue admin invite → activate. Deprovision reverses it (export → archive → drop after retention window).

---

## 8. Observability & SRE Hooks

- **Tracing:** OpenTelemetry SDK → collector → Tempo/Jaeger; `traceId` propagated to responses & logs.
- **Metrics:** Prometheus (RED/USE: request rate, errors, duration; queue depth; DB pool; cache hit).
- **Logs:** structured JSON (pino) → Loki; correlation by `traceId`/`tenantId`.
- **Errors:** Sentry (FE + BE + mobile).
- **Dashboards & alerts:** Grafana + Alertmanager; SLO burn-rate alerts.
- **Uptime:** synthetic checks + public status page.

---

## 9. Environment & Secrets

`.env` per app, Zod-validated. Secrets from cloud secret manager / Vault, injected at runtime. Never commit secrets; rotate DB/JWT/integration keys on schedule. Per-tenant integration credentials encrypted at field level (KMS-backed data keys).
