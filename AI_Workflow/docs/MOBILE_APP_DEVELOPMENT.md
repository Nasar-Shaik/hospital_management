# MOBILE APP DEVELOPMENT — MediCore Native Staff App

The end-to-end engineering reference for building the MediCore mobile app. Companion to the roadmap;
this document is **how we build it**. The governing finding: the API, auth model, and shared client
were designed for a native client before any screen existed, so the mobile app is a **client build**
that reuses the existing backend verbatim. Architecture lives in Doc 04; engineering rules in Doc 09;
this document is the mobile-specific layer over both.

> **Status (2026-08-12):** planning complete, build not started. First audience after the
> foundation is **Doctor** (decided with the product owner). Same one-unit-per-turn, fully-gated,
> Conventional-Commit cadence as every other module.
>
> **Read [MOBILE_M0_ARCHITECTURE.md](MOBILE_M0_ARCHITECTURE.md) alongside this.** It re-verifies
> every decision below against the code as of 2026-08-12 — after response contracts,
> `Idempotency-Key` and the v1 lifecycle policy landed — and supplies what this document predates:
> the state/offline/security/timezone strategies, the navigation tree, the role map, the push
> contract, and the four backend items. Where the two differ, M0 is current. In particular §8 below
> says offline writes queue on `requestId`; **M0 §11 rules that out** for clinical and financial
> mutations, and the central mechanism is now the `Idempotency-Key` header.

---

## 1. The Central Finding — the backend already speaks mobile

Verified in code, not assumed:

| Capability                                                                                                     | Where                                          | What it means for mobile                                                           |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Refresh token returned in the **response body** for native clients (web gets an httpOnly `hms_refresh` cookie) | `apps/api/src/modules/auth/auth.controller.ts` | The app stores the refresh token itself; no cookie jar.                            |
| `/auth/refresh` reads the token from **body or cookie**                                                        | `auth.controller.ts` (`refreshTokenFrom`)      | The app posts `{ refreshToken }` — no browser needed.                              |
| MFA login returns a **body challenge token** (`{ mfaRequired, mfaToken }`)                                     | `auth.service.ts` (`MfaChallenge`)             | MFA is a second POST, no redirect.                                                 |
| Shared client exposes `fetchImpl` + live `getToken()`, **zero browser globals**                                | `packages/api-client/src/index.ts`             | Reuse the typed client as-is; inject RN `fetch`.                                   |
| Tenant resolution is **host-based**                                                                            | `apps/api/src/middleware/resolveTenant.ts`     | A "pick your hospital" step sets the base URL; the Host header carries the tenant. |
| Multi-branch via `X-Active-Branch` header (ADR-0015)                                                           | `apps/api/src/middleware/authorize.ts`         | A branch switcher is one header.                                                   |
| Licence state on every response (`X-License-State`, `X-License-Days-Left`)                                     | `resolveTenant.ts`                             | Renewal banners for free.                                                          |

**Consequence:** 216 REST endpoints, the whole RBAC model, and the shared client are reused
unchanged. The only net-new backend surface is **push delivery** (§7).

---

## 2. Architecture Decisions (locked)

| #   | Decision            | Choice                                                          | Rationale                                                                                                                                                                        |
| --- | ------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Framework           | **React Native + Expo**, as `apps/mobile` in the pnpm workspace | One TS codebase iOS+Android; fits the monorepo; EAS Build for stores; OTA updates for fixes without a review cycle.                                                              |
| M2  | API layer           | **Reuse `@medicore/api-client`** unchanged                      | Inject RN `fetch` via `fetchImpl`, supply `getToken` from secure storage. Same typed contract as web — no fork, no drift.                                                        |
| M3  | Tenant selection    | **Host-based onboarding**                                       | Enter a hospital code / scan a QR → base URL `<slug>.<TENANT_BASE_DOMAIN>`. Multiple hospitals stored as switchable profiles. Zero server change.                                |
| M4  | Auth & session      | **Body tokens + device keystore**                               | Access token in memory; refresh token in `expo-secure-store` (Keychain/Keystore). Per-client rolling refresh (Doc: session model). Biometric unlock designed-for, enabled later. |
| M5  | Data & caching      | **TanStack Query** over the client                              | Cache-first reads, background refetch, optimistic writes; the groundwork for offline.                                                                                            |
| M6  | Navigation & access | **Expo Router + `can()` gating**                                | Reuse `@medicore/permissions`. The tabs a user sees **are** their job description — the web shell's principle.                                                                   |
| M7  | Theming             | **Light + dark from Phase 0**                                   | Parity with the web shell, honouring the device preference. A first-class requirement, not a late add.                                                                           |
| M8  | State (non-server)  | Lightweight store (Zustand)                                     | Session, active hospital, active branch, theme. Server state stays in TanStack Query.                                                                                            |

---

## 3. Monorepo Integration

```
apps/
  api/         (unchanged)
  web/         (unchanged)
  workers/     (+ push sender, §7)
  mobile/      ← NEW  (Expo app)
    app/                 Expo Router routes (file-based)
    src/
      lib/apiClient.ts   api-client factory (fetchImpl + getToken)
      lib/secureStore.ts token persistence (expo-secure-store)
      lib/tenant.ts      hospital profile → base URL
      auth/              session context, login, MFA, refresh timer
      theme/             light/dark tokens (mirror web design system, Doc 08)
      features/<name>/   screens + hooks per feature, mirroring web features
packages/
  api-client, permissions, validation, types  ← reused as-is
```

Rules (extend Doc 09 §1):

- `apps/mobile` may import `packages/*` only — never `apps/api` or `apps/web` internals. _(CI:
  dependency-cruiser, add `apps/mobile` to the ruleset)_
- No copy-paste of client types or permission logic — consume the shared packages.
- Feature folders mirror the web (`features/<name>/`) so a reader who knows the web finds the mobile
  equivalent by name.

---

## 4. Tenant Onboarding Flow (host = tenant)

The web gets its tenant from the browser Host. Mobile has no host, so onboarding **chooses** it.

```
First launch
  → "Enter your hospital code"  (or scan a QR the hospital prints)
  → resolve code → base host  (manual: user types slug; later: directory lookup §7)
  → store a Hospital Profile { label, slug, baseUrl: https://<slug>.<TENANT_BASE_DOMAIN> }
  → all API calls target baseUrl; the Host header carries the tenant through resolveTenant
Multiple hospitals → a switcher; each profile keeps its own stored session.
```

No API change. `resolveTenant.ts` reads the Host exactly as it does for the web.

---

## 5. Auth & Session (native)

### 5.1 Token lifecycle

```
POST /auth/login { email, password }
  → 200 { accessToken, refreshToken, expiresIn }          (proceed)
  → 200 { mfaRequired: true, mfaToken }                    (MFA on)
        POST /auth/mfa/verify { mfaToken, code }
          → { accessToken, refreshToken, expiresIn }
Store: accessToken in memory; refreshToken in expo-secure-store.
Proactive refresh: timer at expiresIn − 60s → POST /auth/refresh { refreshToken }
  → { accessToken, refreshToken, expiresIn }               (rotate both; per-client rolling)
On 401 mid-flight: one refresh attempt, then replay; on refresh failure → sign out.
Logout: POST /auth/logout, wipe secure store + memory.
```

### 5.2 The api-client factory (M2, M4)

```ts
// src/lib/apiClient.ts  — the ONLY place the mobile app constructs a client
import { ApiClient } from "@medicore/api-client";

export function makeClient(baseUrl: string, getToken: () => string | undefined) {
  return new ApiClient({
    baseUrl,
    getToken, // live read — refresh swaps the token without rebuilding
    fetchImpl: fetch, // React Native's global fetch
    getActiveBranch, // → sets X-Active-Branch (§8)
    onLicenseState, // read X-License-State for the renewal banner
  });
}
```

`getToken` returns the in-memory access token; the refresh timer updates that memory. The client
never touches storage — persistence is the app's job (`secureStore.ts`).

### 5.3 Security rules

- Refresh token → `expo-secure-store` only (Keychain/Keystore). Never AsyncStorage, never logs.
- No PHI in logs or crash reports. Screenshot guard on record screens (`expo-screen-capture`).
- Biometric unlock (FaceID/fingerprint) gates re-opening a stored session — **designed-for now,
  enabled in a later phase**.
- Certificate pinning: optional, evaluate at hardening.

---

## 6. Permission-Gated Shell

`GET /auth/me` returns the user + permission set. The shell renders navigation from `can()`
(`@medicore/permissions`) exactly as the web `AppShell` does: a doctor sees "My patients", a nurse
sees the worklist, and neither is offered a screen that would 403. One source of truth for access,
shared across web and mobile.

---

## 7. New Backend Work (the entire list)

Small and itemised — everything else is reuse.

1. **Push delivery** _(new)_
   - Device-token registration: a small endpoint to store `{ userId, platform, expoPushToken }`
     (a collection + migration, following the standard module recipe, Doc 09 §1).
   - Sender: an `apps/workers` job that pushes via **Expo Push → FCM/APNs**, fed by the existing
     **notifications module** (in-app notifications already exist; only device _delivery_ is new).
   - Triggers reuse existing domain events (critical result, assignment) — no new event taxonomy.
2. **Hospital-code → host directory lookup** _(optional)_
   - A tiny public resolve so users needn't type a full domain. **Manual slug entry ships first**;
     this is a convenience, not a blocker.

No auth rework. No tenant rework. No changes to the 216 existing endpoints.

---

## 8. Cross-Cutting Concerns (every phase)

| Concern           | Approach                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Offline**       | TanStack Query read cache + a write queue keyed on the API's `requestId` idempotency (e.g. `placeOrder`) — a retry after a dropped connection never double-posts. |
| **Multi-branch**  | A branch switcher writes `X-Active-Branch`; reads and writes scope to the chosen site (ADR-0015). Active branch persists per hospital profile.                    |
| **Theming**       | Light/dark tokens mirroring the web design system (Doc 08); follow the OS preference, allow an in-app override. Required from Phase 0 (M7).                       |
| **Security**      | §5.3 — secure storage, no PHI in logs, screenshot guard, optional pinning.                                                                                        |
| **Accessibility** | Dynamic type, screen-reader labels, contrast — staff use these one-handed and fast.                                                                               |
| **Release**       | EAS Build for store binaries; OTA updates for JS fixes; staged rollout by cohort.                                                                                 |

---

## 9. Roadmap — endpoints per phase

Each phase is a shippable increment for one audience. Endpoints below already exist unless marked _(new)_.

### Phase 0 — Foundation _(build first)_

Scaffold `apps/mobile` + workspace + CI boundary · api-client factory · secure-storage auth ·
hospital onboarding · login + MFA + refresh timer · permission-gated shell + navigation · light/dark.

- `POST /auth/login`, `POST /auth/mfa/verify`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`
- **Ships:** a signed-in app that opens to the right home for your role.

### Phase 1 — The doctor's round _(first audience)_

My-patients · patient profile read (timeline, vitals, orders, results, prescriptions, allergies) ·
write a consultation note · place orders · e-prescribe.

- Reads: `GET /encounters`, `/orders`, `/reports`, `/prescriptions`, `/invoices`, `/allergies`,
  `/vitals`, `/consultations`, `/mrd/codings/:encounterId` (all `?patientId=`/`?encounterId=`)
- Writes: consultation note (create/sign), `POST /orders` (with `requestId`), prescription
  create + sign
- **Ships:** a doctor can round from their phone.

### Phase 2 — The nurse at the bedside

Ward worklist · vitals capture · MAR bedside administration · allergy check.

- `GET /orders` (worklist), `POST /vitals`, MAR administer, `GET/POST /allergies`
- **Ships:** observations and medication rounds recorded at the bed.

### Phase 3 — Alerts & presence

Push infra live (§7) · notification centre · critical-result & assignment alerts. Lays the rail for
the wanted staff-chat module.

- Device-token register _(new)_ · `GET /notifications` · push sender _(new)_
- **Ships:** the hospital reaches staff in real time.

### Phase 4 — Patient-facing _(likely a separate binary)_

Appointments · reports · bills · wallet — a different audience, sequenced last.

- `GET /appointments`, `/reports`, `/invoices`, wallet endpoints
- **Ships:** patients self-serve their own record.

---

## 10. Definition of Done (per unit)

Mirrors the HMS gate cadence (Doc 09):

- `typecheck` (mobile + any touched package) · `lint` · `pnpm boundaries` (with `apps/mobile` in the
  ruleset) · Expo build/bundle succeeds.
- If a backend endpoint was added (Phase 3 push): api `typecheck`/`lint`/`openapi`/build, and the
  new permission is **granted to a real role** ("a permission nobody holds is a feature nobody has").
- Manual verification per the testing policy (manual-first; no new automated suites unless asked).
- One Conventional Commit per unit, lowercase subject ≤72 chars, `Co-Authored-By` trailer.
- Update `00-PROGRESS-TRACKER.md` and memory.

---

## 11. Open Decisions

- **First audience:** Doctor — **decided**.
- Expo Router vs React Navigation: Expo Router (M6) — revisit only if a routing need it can't meet
  appears.
- Patient app as a separate binary vs a mode of the staff app: lean **separate**; confirm at Phase 4.
- Cert pinning + biometric enablement: defer to a hardening pass after Phase 1.
