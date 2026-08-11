# MOBILE M0 — ARCHITECTURE & FOUNDATION DESIGN

**Status:** design complete, **no mobile code written**. Review gate before M1.
**Supersedes nothing.** Extends [MOBILE_APP_DEVELOPMENT.md](MOBILE_APP_DEVELOPMENT.md) (2026-07-30),
whose locked decisions M1–M8 are re-verified here against the code as it stands on 2026-08-12 —
after response contracts, `Idempotency-Key`, and the v1 lifecycle policy landed.

> **The governing fact, re-verified.** The backend was built for a native client before a screen
> existed. 216 paths, 265 operations, the whole RBAC model, and a React-Native-clean typed client
> are reused **unchanged**. `mobileContract.int.test.ts` proves it: 21 tests drive the shipped
> `@medicore/api-client` against the real app and pass.
>
> **Net-new backend surface for the entire mobile programme: four items** (§21). Two are defects
> that exist today regardless of mobile.

---

## 1. Recommended stack

| Layer          | Choice                                                     | Why this one                                                                                                                                                        |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime        | **React Native via Expo (SDK 54+)**                        | §2.                                                                                                                                                                 |
| Language       | **TypeScript, `strict`**, shared `@medicore/config`        | The repo's tsconfig base. A phone build that type-checks against the same contracts as the API is the whole point.                                                  |
| Navigation     | **Expo Router** (file-based)                               | Typed routes, deep links for free (§12), and the URL model the team already thinks in from Next.js App Router.                                                      |
| Server state   | **TanStack Query v5**                                      | §10. Cache-first reads, background refetch, request de-duplication, and a mutation model that pairs with `Idempotency-Key`.                                         |
| Client state   | **Zustand**                                                | Session, hospital profile, active branch, theme. Four small slices; a reducer framework would be ceremony.                                                          |
| Forms          | **React Hook Form + `@medicore/validation`**               | The same Zod schemas the API validates with. A form that cannot submit an invalid body is better than one that reports the server's rejection.                      |
| API            | **`@medicore/api-client`, unforked**                       | §9.                                                                                                                                                                 |
| Secure storage | **`expo-secure-store`** (Keychain / Keystore)              | §5, §15.                                                                                                                                                            |
| Styling        | **Unistyles** (or StyleSheet + a token module)             | Light/dark from day one (M7), tokens mirroring Doc 08. NativeWind is viable; it is a preference, not a requirement, and the decision can wait for the first screen. |
| Testing        | **Vitest + React Native Testing Library**, Maestro for E2E | §16.                                                                                                                                                                |
| Build          | **EAS Build + EAS Update**, with the OTA policy in §17     | §17.                                                                                                                                                                |

**Deliberately NOT adopted:** Redux/RTK (server state belongs in Query, and what is left is four
fields) · a local SQLite mirror of PHI (§11, §15) · a second HTTP layer · Socket.IO (ADR-0008 is
accepted but unbuilt; polling is honest until it exists).

> **Note on divergence from the web.** `apps/web` has none of TanStack Query, Zustand or React Hook
> Form — recorded as deviation D4 in PROJECT-STATUS, because Doc 04 §3.1 mandates them. Mobile
> adopting them is not a new direction; it is the first implementation of the standard the web
> still owes. Mobile becomes the reference, not the exception.

---

## 2. Expo vs bare React Native — **Expo**

Not a close call, and the reasons are operational rather than aesthetic.

**For Expo**

- Every native module this app needs is first-party and maintained: `expo-secure-store`,
  `expo-local-authentication`, `expo-screen-capture`, `expo-notifications`, `expo-file-system`,
  `expo-document-picker`, `expo-image-picker`, `expo-sharing`. In a bare app each is a separate
  dependency with its own linking story and its own abandonment risk.
- **EAS Build removes an entire class of CI work.** This repo's CI is currently billing-locked and
  has no macOS runner. Bare RN means owning Xcode toolchains, provisioning profiles and signing on
  a machine we do not have. EAS is a hosted answer to a problem we would otherwise have to solve
  first.
- **EAS Update** ships a JS fix without a review cycle — which matters when the fix is a
  mis-rendered dose. Governed by the policy in §17, not used as a way around review.
- `expo prebuild` is a **one-way door we can walk through later**: if a native need appears that
  Expo cannot express, we generate the native projects and continue. Starting bare to preserve an
  option we can take at any time is paying now for a choice we may never make.

**The honest costs**

- Larger binary (~5–8 MB over bare). Irrelevant for a staff app.
- New RN versions arrive on Expo's SDK cadence, not React Native's release day. Also irrelevant —
  we have no reason to chase.
- A native module outside Expo's catalogue needs a config plugin or a prebuild. None is foreseen.

**Decision: Expo, managed workflow, with `expo prebuild` as the documented escape hatch.**
This confirms M1 in the existing doc.

---

## 3. Architecture

```
┌─────────────────────────── apps/mobile (Expo) ───────────────────────────┐
│                                                                          │
│  app/            Expo Router — routes only, no logic                     │
│      (auth)/          onboarding · login · mfa                           │
│      (app)/           role tabs · nested stacks · modals                 │
│                                                                          │
│  src/features/<name>/ screens + hooks, mirroring apps/web/app/<name>     │
│                             │                                            │
│                             ▼                                            │
│  ┌──── server state ────┐   ┌──── client state ────┐                     │
│  │  TanStack Query      │   │  Zustand             │                     │
│  │  queryKey includes   │   │  session · hospital  │                     │
│  │  [tenant, branch]    │   │  activeBranch · theme│                     │
│  └──────────┬───────────┘   └──────────┬───────────┘                     │
│             │                          │ getAccessToken/getActiveBranch  │
│             ▼                          ▼  (live reads, never props)      │
│  ┌────────────────────── src/lib/apiClient.ts ───────────────────────┐   │
│  │  THE ONLY `new ApiClient(...)` IN THE APP                          │   │
│  │  fetchImpl = RN fetch · onUnauthorized · onLicenseState ·          │   │
│  │  onDeprecation · idempotencyKey per intent                        │   │
│  └────────────────────────────┬──────────────────────────────────────┘   │
│                               │                                          │
│  src/lib/secureStore.ts ──────┤  refresh token only (Keychain/Keystore)  │
│  src/lib/tenant.ts ───────────┤  hospital profile → baseUrl (Host)       │
└───────────────────────────────┼──────────────────────────────────────────┘
                                │  HTTPS
                                ▼
        ┌──────────────── @medicore/api-client (unforked) ────────────────┐
        │  Authorization · Host · X-Active-Branch · Idempotency-Key       │
        │  ApiClientError · licence + deprecation headers · API_VERSION   │
        └────────────────────────────┬────────────────────────────────────┘
                                     ▼
        ┌──────────────────── apps/api  /api/v1 (unchanged) ──────────────┐
        │  resolveTenant → authenticate → authorize → validate →          │
        │  responds → idempotent → handler                                │
        │  AUTHORITATIVE for tenancy, RBAC, branch scope, money           │
        └─────────────────────────────────────────────────────────────────┘
```

**The invariant the whole design rests on:** the phone is a _renderer of decisions the server has
already made_. It hides what a user cannot do; it never decides what they may.

---

## 4. Monorepo structure

No second monorepo. `apps/mobile` joins the existing pnpm workspace.

```
apps/
  api/ web/ admin/ workers/          unchanged
  mobile/                            ← NEW
    app.config.ts                    Expo config; env per profile
    eas.json                         development · preview · production
    app/                             Expo Router (routes ONLY)
      _layout.tsx                    providers: Query, Zustand hydrate, theme
      (auth)/ _layout.tsx  hospital.tsx  login.tsx  mfa.tsx
      (app)/  _layout.tsx            the shell: tabs from permissions
              index.tsx              role home (redirects by role)
              patients/ [id]/ …      nested stacks
              queue/  orders/  pharmacy/  billing/  notifications/
              settings/ branch.tsx  about.tsx
      +not-found.tsx
    src/
      lib/apiClient.ts               the ONLY ApiClient construction
      lib/secureStore.ts             refresh token; nothing else
      lib/tenant.ts                  hospital profile ⇄ baseUrl
      lib/idempotency.ts             useIntentKeys — ported from apps/web
      lib/logger.ts                  redacting; no PHI, ever
      lib/time.ts                    hospital-zone formatting (§14)
      state/session.ts  branch.ts  theme.ts   Zustand slices
      query/keys.ts  client.ts       queryKey factory, retry policy
      auth/                          session context, refresh timer, biometric gate
      navigation/tabsFor.ts          permissions → tabs (§8)
      features/<name>/               screens + hooks, named as apps/web
      components/                    shared primitives (mirror packages/ui tokens)
      theme/                         light/dark tokens from Doc 08
    __tests__/                       unit + component
    maestro/                         E2E flows
packages/                            api-client · permissions · types · validation · config
                                     — consumed, never copied
```

**Boundary rule (extends Doc 09 §1, enforced by dependency-cruiser):** `apps/mobile` may import
`packages/*` only — never `apps/api` or `apps/web` internals. Adding `apps/mobile` to
`.dependency-cruiser.cjs` is part of M1's first commit, not an afterthought.

---

## 5. Authentication flow

Exactly what the API already expects — verified in `mobileContract.int.test.ts`.

```
┌ FIRST LAUNCH ─────────────────────────────────────────────────────────────┐
│ enter hospital code (or scan the QR the hospital prints)                  │
│   → baseUrl = https://<slug>.<TENANT_BASE_DOMAIN>                         │
│   → save HospitalProfile { label, slug, baseUrl }   (plain storage: not a secret) │
└───────────────────────────────────────────────────────────────────────────┘
                                   ▼
POST /auth/login { email, password, device: "<model> / <os>" }
   │
   ├─ TokenPair    { accessToken, refreshToken, expiresIn, user }
   └─ MfaChallenge { mfaRequired: true, mfaToken, expiresIn }
            └→ POST /auth/mfa/verify { mfaToken, code } → TokenPair

   isMfaChallenge(result) narrows the union. The client exports it precisely so a
   login screen cannot forget the second branch and render a home for a half-authenticated user.
                                   ▼
STORE   accessToken  → memory only (Zustand, never persisted)
        refreshToken → expo-secure-store  (Keychain / Android Keystore)
        user + permissions → memory; re-fetched from GET /auth/me on resume
                                   ▼
REFRESH  proactive: timer at expiresIn − 60s
         reactive:  ApiClient.onUnauthorized → refresh once → replay the SAME request
                    (and, for a mutation, the SAME Idempotency-Key — a token that expires
                     between a write and its response is exactly what the key is for)
         POST /auth/refresh { refreshToken }   ← BODY, not a cookie. The native path.
         rotating: the response's refreshToken replaces the stored one. Reuse of a rotated
         token is detected server-side (HMS-AUTH-003) and revokes the family → sign out.
                                   ▼
LOGOUT   DELETE the device registration (§12) → POST /auth/logout
         → wipe secure store, clear Query cache, reset Zustand, navigate to (auth)
```

**Rules.** The refresh token never touches AsyncStorage, never a log, never a crash report. The
access token is never persisted at all — a cold start costs one refresh round-trip, which is the
correct price. The client reads both through callbacks (`getAccessToken`), so a refresh swaps the
token without rebuilding anything.

---

## 6. Tenant flow

The web gets its tenant from the browser Host. **Mobile chooses it**, and that choice becomes the
base URL — `resolveTenant.ts` is untouched.

```
HospitalProfile { label, slug, baseUrl, lastUserEmail? }   ← 0..n, plain storage
   each profile owns its own secure-store namespace for its refresh token
   switching hospital = switch profile → new ApiClient → sign in (or resume) there
```

- **Discovery:** manual slug entry ships first. A QR code the hospital prints is a two-day
  convenience on top. A public directory lookup (`GET /tenants/resolve?code=`) is **optional** and
  deliberately deferred — it is the only piece that would need a new public endpoint.
- **No second tenant system.** The app stores a URL. Everything else is the server's.
- **Switching:** allowed, and it is a full context change — clear the Query cache, reset the active
  branch, re-read `/auth/me`. A cross-tenant token is refused with `HMS-TEN-003`; the app should
  never generate one, and the test proves the server catches it if it does.

---

## 7. Branch flow (ADR-0015)

```
after login →  GET /me/branches  →  { branches: Branch[], canAggregate: boolean }
                       │
        ┌──────────────┼──────────────────────────────┐
        │ 1 branch     │ n branches                   │ canAggregate
        │ select it    │ restore persisted choice if  │ "All branches" is a
        │ silently     │ still a member, else prompt  │ legal state for READS
        └──────────────┴──────────────────────────────┘
                       ▼
   Zustand `activeBranch` → ApiClient.getActiveBranch() → X-Active-Branch on EVERY request
                       ▼
   persisted per (hospital profile, user) — not globally
```

| Case                           | Behaviour                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After login                    | Restore the persisted branch **only if it is still in `/me/branches`**. Otherwise prompt. Never send a stale id and hope.                                       |
| Switching                      | Set the store value; the next request carries it. **Invalidate every server query** — the same key against a different branch is different data.                |
| Membership changed server-side | The write returns `HMS-BRANCH-001` or a 403. Treat as a signal: re-fetch `/me/branches`, re-prompt, do not retry blindly.                                       |
| All-branches (`canAggregate`)  | Reads aggregate; **writes must resolve one branch**. The UI asks _before_ opening a write form, not after the server refuses — the refusal is correct but late. |
| Validation                     | **None on the phone.** `authorize` validates the header against the caller's allowed set. A client-side check would be a second, drifting copy.                 |

---

## 8. Permission / navigation flow

`GET /auth/me` returns `permissions: string[]`. The shell is derived from it, exactly as the web's
`AppShell` is.

```ts
// src/navigation/tabsFor.ts — the ONE place permissions become navigation
const TABS = [
  { name: "queue", title: "Queue", icon: "list", needs: ["encounter:read"] },
  { name: "patients", title: "Patients", icon: "users", needs: ["patient:read"] },
  { name: "orders", title: "Orders", icon: "flask", needs: ["order:read"] },
  { name: "pharmacy", title: "Pharmacy", icon: "pill", needs: ["pharmacy:dispense"] },
  { name: "billing", title: "Billing", icon: "rupee", needs: ["billing:read"] },
  { name: "alerts", title: "Alerts", icon: "bell", needs: [] },
] as const;

export const tabsFor = (held: Set<string>) => TABS.filter((t) => t.needs.every((p) => held.has(p)));
```

- **No `if (role === "DOCTOR")` anywhere.** Roles are tenant-editable data; permissions are code
  (`@medicore/permissions`). A hospital that renames DOCTOR to CONSULTANT must not break the app.
- Role is used for **one** thing: choosing which home screen `(app)/index.tsx` redirects to. That
  is a presentation default, not an access decision, and it falls back to the first available tab.
- A screen reached by deep link still checks `can()` before rendering, and still shows the server's
  403 if it happens — the UI hides, the server enforces.
- More than 5 tabs → the surplus moves to a "More" sheet. An admin holding everything must not get
  a nine-tab bar.

---

## 9. API client integration — the exact boundary

**One file constructs the client. Nothing else imports `ApiClient`.**

```ts
// src/lib/apiClient.ts
export function makeClient(profile: HospitalProfile): ApiClient {
  return new ApiClient({
    baseUrl: profile.baseUrl,
    fetchImpl: fetch, // RN's global fetch
    credentials: "omit", // no cookie jar on a phone
    getAccessToken: () => sessionStore.getState().accessToken,
    getActiveBranch: () => branchStore.getState().activeBranchId,
    onUnauthorized: refreshOnce, // → true replays the request
    onLicenseState: (s) => licenceStore.getState().set(s),
    onDeprecation: (n, path) => log.warn({ path, sunsetAt: n.sunsetAt }, "endpoint sunsetting"),
  });
}
```

| Capability            | Status | How mobile uses it                                                                                                                                                   |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchImpl` injection | ✅     | RN's global `fetch`. Also the seam for an offline-detecting wrapper (§11).                                                                                           |
| Auth                  | ✅     | `getAccessToken` live-read from Zustand.                                                                                                                             |
| Silent refresh        | ✅     | `onUnauthorized` → refresh → the client replays, reusing the same idempotency key.                                                                                   |
| Tenant host           | ✅     | `baseUrl` per hospital profile. **`tenantHost` is not set** — that option exists for tests where the URL cannot carry the host; in production the URL _is_ the host. |
| `X-Active-Branch`     | ✅     | `getActiveBranch` live-read; switching needs no new client.                                                                                                          |
| Licence headers       | ✅     | `onLicenseState` → renewal banner, no polling.                                                                                                                       |
| `ApiClientError`      | ✅     | `status`, `code`, `message`, `details`, `traceId`. Error mapping in §11.                                                                                             |
| `Idempotency-Key`     | ✅     | Typed param on the 12 money methods; `request(..., { idempotencyKey })` for the rest.                                                                                |
| `API_VERSION`         | ✅     | Shown on the About screen and attached to crash reports.                                                                                                             |
| Deprecation receiver  | ✅     | `onDeprecation` → log + (later) an in-app "update available" nudge.                                                                                                  |

**Forbidden:** a second HTTP layer, a fork, a re-declared response type, a hand-rolled retry around
the client. If the client lacks something, it is added **to the package** and the contract gates
verify it — that is the whole reason `client:check` exists.

---

## 10. State management

| Kind             | Owner                | Examples                                                                                                                   |
| ---------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Server state** | TanStack Query, only | patients · appointments · encounters · orders · prescriptions · billing · wallet · queues · notifications · `/me/branches` |
| **Session**      | Zustand `session`    | accessToken (memory) · user · permissions                                                                                  |
| **Context**      | Zustand `branch`     | hospital profile · activeBranchId · canAggregate                                                                           |
| **Preferences**  | Zustand `theme`      | colour scheme override · text scale                                                                                        |
| **Ephemeral UI** | `useState` / router  | active tab · modal · form state · filters · scroll position                                                                |

**Rules that keep the two from merging.**

1. **Server data is never copied into Zustand.** A patient in a store is a patient that goes stale
   the moment someone else edits them, and the staleness is invisible.
2. **`queryKey` always begins `[tenantSlug, branchId ?? "all", …]`.** The same query in two branches
   is two caches; without this a branch switch shows the previous site's list for one frame — and a
   list of the wrong patients is a clinical error, not a rendering one.
3. **Mutations invalidate, they do not patch** — except for the small set where an optimistic update
   is genuinely better UX (marking a notification read). Never optimistic for money.
4. On sign-out, hospital switch, or branch switch: `queryClient.clear()`.

---

## 11. Network / offline strategy

**Reads may be cached. Clinical and financial WRITES are never queued.** The instruction is right
and the reason is worth stating: a queued write is a promise the app cannot keep — the bed may be
taken, the drug may be out of stock, the bill may be settled. A phone that says "saved" and means
"maybe, later" is worse than one that says "no signal".

| Situation             | Behaviour                                                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Online                | Query cache-first with background refetch. `staleTime` 30 s for lists, 0 for a bill.                                                                                                                                                          |
| Offline               | Cached reads render with an explicit "last updated HH:MM" banner. **Write buttons are disabled**, not queued — with the reason shown.                                                                                                         |
| Timeout               | 15 s. One retry for **idempotent reads only**. A mutation is never auto-retried by the transport; retry is a user action carrying the same key.                                                                                               |
| Token expired         | `onUnauthorized` → refresh → replay. Invisible.                                                                                                                                                                                               |
| Refresh fails / 401×2 | Sign out, keep the hospital profile, return to login with "your session ended".                                                                                                                                                               |
| Server unavailable    | 502/503/504 → "the hospital's system is not reachable", with retry. Never a stack trace, never a raw `traceId` unless the user opens Details.                                                                                                 |
| **403**               | `HMS-AUTH-005` → "you do not have access". Also a signal the cached permission set is stale → re-fetch `/auth/me`.                                                                                                                            |
| **409**               | `HMS-REQ-002` "already submitted under this reference — reload" · `HMS-REQ-004` "still going through, wait" · `HMS-REQ-003` "changed since you loaded" · `HMS-APT-001`/`HMS-ADM-001` "taken, pick another", with alternatives from `details`. |
| Validation (400)      | `HMS-VAL-001` → `details.fields` mapped onto the form fields by name. The API's shape is designed for this.                                                                                                                                   |
| Idempotency replay    | A 2xx with `Idempotency-Replayed: true` is a **success**, not a duplicate — render it as done. This is what makes "tap again" safe.                                                                                                           |
| Branch changed        | `HMS-BRANCH-001` / 403 on a write → re-fetch `/me/branches`, re-prompt (§7).                                                                                                                                                                  |
| Licence expired       | `HMS-TEN-005` → a blocking screen, not a toast. The hospital's operator must renew.                                                                                                                                                           |

**Idempotency in the app.** Port `useIntentKeys` from `apps/web`: mint on commit, hold across
retries of that intent, drop on success, drop when the request changes. The web's lesson is
recorded because it will be repeated otherwise — two of its keys were `` `…-${Date.now()}` ``, a
new key per click, which protected nothing while looking exactly like protection.

**The one offline exception worth revisiting later:** bedside vitals capture in a basement ward with
no signal. It has a genuine claim, and it needs its own design (conflict rules, a visible pending
state, an expiry). **Out of scope for M0 and for M1–M3.**

---

## 12. Notification architecture

### Today, verified

- `notifications` collection exists, tenant-scoped, `branchId`-aware, deduped on `dedupeKey`.
- Channels: `email` and `inapp` are implemented; `push` is **in the enum with no implementation**.
  `channels/channel.ts` `registerChannel()` is the extension point — one file, no new model.
- **Gap found:** there is **no endpoint for a user to read their own inbox.** `GET /notifications`
  requires `notification:manage` and returns the whole hospital's messages including patient PHI.
  `inapp.ts` comments refer to `GET /notifications/me` — it does not exist.

### Designed contract (implement in M3, not now)

```
POST   /api/v1/me/devices     { platform: "ios"|"android", pushToken, appVersion, deviceName? }
                              → Device { id, platform, lastSeenAt }        201 / replay
DELETE /api/v1/me/devices/:id                                              on logout
GET    /api/v1/me/devices     the user's own devices, for "sign out everywhere"
GET    /api/v1/notifications/me  ?unread=&page=  the caller's OWN inbox     ← closes the gap
POST   /api/v1/notifications/me/:id/read
```

```
devices  { tenantId, userId, platform, token, appVersion, deviceName,
           lastSeenAt, disabledAt? }
         unique (tenantId, token)      ← one row per device per hospital
```

| Question         | Answer                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Permission       | **None beyond `authenticate()`** — self-service, like `/me/branches`. Registering your own phone is not an administrative act.                                                 |
| Tenant isolation | Rows live in the tenant DB. A user who works at two hospitals has **two rows with the same token**; the sender scopes by tenant, so hospital A can never push about B.         |
| Multiple devices | Natural: one row per device. Fan-out to all non-disabled rows.                                                                                                                 |
| Logout           | `DELETE` the row **before** `/auth/logout` — a token left registered pushes patient data to a phone somebody else is now holding.                                              |
| Stale tokens     | FCM/APNs report "unregistered" → set `disabledAt`. Never delete: the row is evidence of a delivery attempt.                                                                    |
| Branch context   | Payload carries `branchId`; tapping switches the active branch before navigating, so the record opens in the site it belongs to.                                               |
| Permissions (OS) | Asked **in context**, not at first launch — after the first alert-worthy event, explaining what it is for. A denied prompt is near-impossible to recover.                      |
| Deep links       | `medicore://<slug>/patients/<id>` + universal links. Payload `{ tenantSlug, branchId, resource, id, notificationId }`. Unauthenticated → store the intent, resume after login. |
| Content          | **No PHI in the push body.** "New critical result" and a deep link — never the value, never the patient's name. A lock screen is a public surface.                             |
| Transport        | Expo Push → FCM/APNs, sent by an `apps/workers` job fed by the existing notifications module. **No second notification model.**                                                |

---

## 13. File / media strategy

The API's contract, verified in the mobile suite. No second storage provider; nothing about storage
changes.

| Flow        | Endpoint                                                            | Mobile handling                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upload      | `POST /patients/:id/documents`, `POST /orders/:id/reports` (base64) | `expo-image-picker` / `expo-document-picker` → `expo-file-system.readAsStringAsync(…, { encoding: Base64 })`. Base64 is the one representation every RN file library produces. |
| PDF / image | `fetchDocumentBlob`, `fetchReportBlob` → `Blob`                     | Write to `FileSystem.cacheDirectory`, open with `expo-sharing` / a PDF viewer. **Cache dir, never document dir** — PHI must not survive in a backed-up folder.                 |
| CSV         | `fetchAuditCsv`, `fetchReportCsv` → `Blob`                          | Same; share sheet. `fetchAuditCsv` also returns `truncated` — surface it, a partial export looks complete.                                                                     |
| Logo        | `fetchSiteLogoBlob` → `Blob \| null`                                | `null` is a legal answer; render the fallback.                                                                                                                                 |
| Size        | Reports cap at ~15 MB base64                                        | Compress images client-side before encoding. Base64 is ~33% overhead — budget for it.                                                                                          |

**`Blob`, never `arrayBuffer()`.** RN's fetch is XHR-backed and does not implement `arrayBuffer()`
on every version; the client already commits to `Blob` throughout for exactly this reason.

**Never** hang an authenticated download on a bare URL. That defect existed (`auditExportUrl`) and
was fixed this milestone; RN has no way to open an authenticated URL in a browser at all.

---

## 14. Timezone strategy

### The defect, precisely

The primitives are correct and already exist — `core/time/day.ts` has zone-aware `dayRangeInZone`
and `zoneOffsetMs`, and `encounter.controller.ts` and `billing.consumers.ts` use them properly.
**`appointment.service.ts` does not:** it resolves a doctor's weekday and slot minutes with
`Date.getDay()` and `setHours()`, i.e. in the **process** timezone. The reminder mail then renders
in `env.DEFAULT_TIMEZONE`. Those agree only when the container's `TZ` is the hospital's zone — and
nothing sets `TZ`: no Dockerfile, no compose file, no `.env.example`. The shipped image runs UTC,
where a clinic's "Monday 09:00" is offered at 09:00 UTC and the patient is emailed "02:45 pm".

The test suite pins `TZ: Asia/Kolkata`, which reproduces today's behaviour deterministically and
**hides the defect** — deliberately, and recorded as such.

### The canonical strategy

```
1. STORE + TRANSMIT   UTC instants, ISO 8601.  Already true — `Wire<T>` maps Date → ISO string.
2. DECIDE             every "what day / what hour" question resolves in an EXPLICIT zone:
                          branch.timezone  ??  tenant default  ??  env.DEFAULT_TIMEZONE
                      never the process zone, never the device zone.
3. DISPLAY            the phone renders in the BRANCH's zone by default, labelled.
                      The device zone is available as an explicit toggle, never a silent default.
```

**Why the branch zone and not the device zone.** A doctor on call from another state must see the
medication round at the time the ward will give it. A clock that quietly follows the phone turns
"08:00 dose" into a different number for every reader — and a phone crossing a timezone on a train
would change a schedule nobody edited. Mobile invents nothing here: it reads the zone from
`Branch.timezone` (the field exists) and formats.

**Required backend correction** — small, itemised in §21, and it exists independently of mobile.

---

## 15. Security strategy

| Concern             | Decision                                                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refresh token       | `expo-secure-store` (Keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY` / Android Keystore). Never AsyncStorage.                                                                                                                                                                                             |
| Access token        | **Memory only.** Never persisted. A cold start costs one refresh.                                                                                                                                                                                                                                   |
| Logout              | Delete the device row → `/auth/logout` (server-side revoke, already implemented) → wipe secure store → `queryClient.clear()` → reset stores. In that order.                                                                                                                                         |
| Biometric unlock    | `expo-local-authentication` gates _resuming a stored session_ after N minutes background. **Designed in M0, enabled in M2** — a broken biometric gate locks a nurse out mid-round, so it ships with a passcode fallback.                                                                            |
| Screenshots         | `expo-screen-capture` `preventScreenCaptureAsync()` on PHI screens. **Android enforces (FLAG_SECURE); iOS can only _detect_, not prevent** — on iOS we log the event and show a privacy notice. Saying otherwise would be a false assurance.                                                        |
| App switcher        | Blur/overlay the app on background — the snapshot iOS takes is PHI.                                                                                                                                                                                                                                 |
| Clipboard           | No auto-copy of PHI. Where copy is offered (UHID, invoice number), clear after 60 s.                                                                                                                                                                                                                |
| Cached PHI          | Query cache is **in memory only** — no persister. A local encrypted DB is not worth its key-management story for a staff app that is online in the building.                                                                                                                                        |
| Logging             | A redacting logger: allow-list of fields, never a request body, never a response body, never a token. Crash reports scrubbed the same way, and `traceId` is the join key instead.                                                                                                                   |
| Certificate pinning | **Deferred, with a stated precondition.** A pinned app that outlives its certificate is a bricked hospital with no remote fix. Revisit only when there is a rotation runbook, two pinned keys (current + next), and a remote kill switch. Meanwhile: HTTPS + ATS/`cleartextTrafficPermitted=false`. |
| Device compromise   | Assume a rooted device reads everything the app stores. Therefore: short access-token TTL, server-side revocation, no PHI at rest, and root/jailbreak **detection as telemetry**, never as a hard block (it is trivially bypassed and blocks legitimate users).                                     |
| Deep links          | Never trust a link's payload for authorization. Resolve the id through the API and let the server refuse.                                                                                                                                                                                           |

---

## 16. Testing strategy

Prioritised by what hurts: **money and clinical writes first.**

| Layer       | Tool                              | What it covers                                                                                                                                                                                              |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Vitest                            | `tabsFor` (permissions → tabs) · `useIntentKeys` (mint/hold/drop) · error→message mapping · timezone formatting · secure-store wrapper.                                                                     |
| API client  | **already exists**                | `mobileContract.int.test.ts` — 21 tests through the real client. Mobile extends this file rather than starting a parallel one.                                                                              |
| Component   | RN Testing Library                | Login (incl. the MFA branch) · branch switcher · a write form's 409/validation paths · the offline banner.                                                                                                  |
| Navigation  | RN Testing Library + router mocks | The right tabs for each permission set · deep link → correct screen · unauthenticated deep link → login → resume.                                                                                           |
| Integration | Vitest + injected fetch           | The same trick the contract suite uses: real client, faked transport, assert the sequence of requests a workflow produces.                                                                                  |
| E2E         | Maestro                           | **Five flows only:** login+MFA · branch switch changes the list · doctor places an order (and a double-tap places ONE) · pharmacy dispenses · cashier takes a payment (and a retry does not double-charge). |

**The two E2E assertions that justify the whole suite:** a double-tap creates one order, and a
retried payment takes the money once. Those are the failures the idempotency work exists to prevent
and the only ones a phone makes _more_ likely.

---

## 17. Build / release strategy

**EAS.** Three profiles in `eas.json`:

| Profile       | Android                     | iOS                     | Env                         |
| ------------- | --------------------------- | ----------------------- | --------------------------- |
| `development` | dev client APK, sideload    | dev client, simulator   | staging API                 |
| `preview`     | internal-testing APK/AAB    | **TestFlight** internal | staging or a pilot hospital |
| `production`  | AAB → Play (staged rollout) | App Store               | production                  |

- **Signing:** EAS-managed credentials (keystore + iOS certs/profiles) with an exported backup held
  in the same secret store as the API's. A lost Android keystore means a new app listing.
- **Environment:** `app.config.ts` reads the profile; **no baked-in tenant.** The hospital is chosen
  at runtime (§6), so one binary serves every hospital. White-label per reseller is a later build
  profile, not a fork.
- **OTA policy (this is the part that needs a rule).** EAS Update may ship: copy fixes, layout
  fixes, non-clinical logic. It may **not** ship: changes to dosing, ordering, dispensing or money
  logic, or anything a reviewer would have caught. Those go through a store release. An OTA channel
  is a fast path, not an unreviewed one — and every OTA is a commit that passed the same gate.
- **Version:** `API_VERSION` from the client plus the app's own build number in the About screen and
  in every crash report. When a `Sunset` header eventually arrives, we need to know which builds are
  still calling it.

---

## 18. Role-based feature map

Mobile is **not** the desktop with a narrower column. Each role gets the two or three things that
are genuinely better on a phone: something you do standing up, away from a desk, with one hand.

| Role               | Primary daily workflow                 | Highest-value mobile actions                                                                             | Notifications                              | Branch behaviour                      | Deliberately NOT on mobile                               |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------- | -------------------------------------------------------- |
| **Doctor** (first) | Ward round; OP clinic between patients | My patients → timeline · vitals · results · **place order** · **e-prescribe + sign** · consultation note | Critical result · new assignment           | Usually one; consultants switch sites | Report building, tariff config, MRD coding               |
| **Nurse**          | Bedside, continuous                    | Ward worklist · **record vitals** · **MAR administration** · allergy check · handover notes              | Due medication · new admission to the ward | Fixed to their ward's branch          | Billing, ordering, discharge summaries                   |
| **Reception**      | A queue of people at a counter         | Register patient · book/check-in appointment · **take payment** · print/share receipt                    | Queue backlog                              | Fixed to the desk's branch            | Refunds and discounts (approval-gated, desk work)        |
| **Pharmacy**       | A counter and a stock room             | Dispense queue · **dispense with quantities** · stock lookup · credit-override request                   | New prescription · low stock               | Fixed to the counter's branch         | Purchase orders, GRN, formulary editing                  |
| **Laboratory**     | Bench work, hands busy                 | Worklist · accept/start/complete · **enter result** · flag critical                                      | New urgent order                           | Fixed to the lab's branch             | Verification (a second pair of eyes belongs at a screen) |
| **Admin**          | Oversight, mostly elsewhere            | Today at a glance · occupancy · collections · **approve** discount/refund requests · licence state       | Approval requests · licence expiring       | **All branches** by default           | Everything configurational                               |

**Sequencing:** Doctor → Nurse → Reception/Pharmacy → Lab → Admin. Confirms the existing decision,
and each is a shippable audience.

---

## 19. Navigation tree

```
app/
├── (auth)/                                    unauthenticated
│   ├── hospital          hospital code / QR → profile        [entry when no profile]
│   ├── login             email + password
│   ├── mfa               MfaChallenge branch
│   └── switch-hospital   profile list + add
│
├── (app)/                 authenticated shell — tabs from tabsFor(permissions)
│   ├── index              role home → redirect to the first available tab
│   │
│   ├── queue/             [encounter:read]
│   │   ├── index          today · filters · search
│   │   └── [encounterId]  encounter detail → modal actions
│   │
│   ├── patients/          [patient:read]
│   │   ├── index          search (UHID / phone / name)
│   │   └── [patientId]/
│   │       ├── index      header + timeline
│   │       ├── vitals · orders · results · prescriptions · allergies · billing
│   │       └── documents  view / upload
│   │
│   ├── orders/            [order:read]
│   │   ├── index          worklist (?category&outstanding)
│   │   └── [orderId]      detail → accept/start/complete/result
│   │
│   ├── pharmacy/          [pharmacy:dispense]
│   │   ├── index          dispense queue
│   │   └── [prescriptionId]  dispense sheet (quantities → confirm)
│   │
│   ├── billing/           [billing:read]
│   │   ├── index          outstanding
│   │   └── [invoiceId]    detail → take payment (modal)
│   │
│   ├── alerts/            everyone
│   │   └── index          inbox (needs GET /notifications/me — §21)
│   │
│   └── settings/
│       ├── index          profile · theme · about (API_VERSION, build)
│       ├── branch         branch switcher
│       └── devices        signed-in devices → sign out everywhere
│
└── +not-found

MODALS (presented over the shell, never a tab)
  place-order · write-prescription · record-vitals · administer-dose
  take-payment · register-patient · book-appointment

DEEP LINKS
  medicore://<slug>/patients/<id>          medicore://<slug>/orders/<id>
  medicore://<slug>/encounters/<id>        medicore://<slug>/alerts/<notificationId>
  unauthenticated → stash the intent → (auth)/login → resume
  branch in the payload → switch active branch, then navigate
```

---

## 20. Implementation phases

| Phase  | Scope                                                                                                                                                                                                  | Ships                                        | Backend needed  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | --------------- |
| **M1** | Scaffold `apps/mobile` · dependency-cruiser boundary · api-client factory · secure storage · hospital onboarding · login + MFA + refresh · `/auth/me` · permission tabs · light/dark · branch switcher | A signed-in app that opens on the right home | **none**        |
| **M2** | Doctor: my-patients · patient timeline · vitals/results/orders/prescriptions read · **place order** · **e-prescribe + sign** · consultation note · biometric gate on                                   | A doctor can round from their phone          | **none**        |
| **M3** | Nurse: ward worklist · vitals capture · MAR administration · allergy check                                                                                                                             | Observations recorded at the bed             | **none**        |
| **M4** | Alerts: device registration · push sender · inbox · deep links                                                                                                                                         | The hospital reaches staff in real time      | **A + B** (§21) |
| **M5** | Reception + Pharmacy: register · check-in · **take payment** · dispense queue                                                                                                                          | The counters work on a phone                 | none            |
| **M6** | Lab + Admin: worklist · result entry · approvals · at-a-glance                                                                                                                                         | The remaining roles                          | none            |
| **M7** | Hardening: accessibility pass · offline read polish · performance · pilot rollout                                                                                                                      | Production-ready                             | none            |
| **M8** | Patient app _(separate binary, separate decision)_                                                                                                                                                     | Appointments · reports · bills · wallet      | TBD             |

Each phase keeps the repo cadence: one unit per turn, full gate, one Conventional Commit.

---

## 21. Backend changes required

Four items. **Two are defects that exist today with or without mobile.**

| #     | Change                                                                                                                                                                                                                                                                                                                                                                                                  | Size                                                                         | When                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------- |
| **A** | **`GET /notifications/me` + mark-read.** A staff member cannot read their own inbox: `GET /notifications` needs `notification:manage` and returns the hospital's PHI. `inapp.ts` already refers to an endpoint that does not exist.                                                                                                                                                                     | Small — one route, one query, reuses the existing model                      | Before M4. Useful without mobile.     |
| **B** | **Device registration + push sender.** `POST/GET/DELETE /me/devices`, a `devices` collection + migration, and an `apps/workers` job wiring the existing `push` channel through Expo Push → FCM/APNs. Contract designed in §12.                                                                                                                                                                          | Medium — one module + one worker                                             | M4                                    |
| **C** | **Appointment timezone correction.** `appointment.service.ts` resolves the weekday and slot minutes in the _process_ zone; everything else uses `env.DEFAULT_TIMEZONE`. On the shipped UTC image a clinic's 09:00 is offered at 14:30 IST. Use the existing `core/time` primitives with `branch.timezone ?? tenant ?? env`. **A live defect, not a mobile need** — mobile only makes it visible sooner. | Small, but needs its own tests (and the suite's `TZ` pin currently hides it) | Before M2. Independently worth doing. |
| **D** | _(Optional)_ **Hospital directory lookup** — a public `GET /tenants/resolve?code=` so users need not type a domain. Manual slug entry ships first; this is convenience.                                                                                                                                                                                                                                 | Small                                                                        | Any time, or never                    |

**Not required, and worth saying:** no auth rework · no tenant rework · no RBAC change · no branch
change · no change to any of the 265 existing operations · no storage provider.

---

## 22. Risks and blockers

| Risk                                                                                                      | Severity                 | Mitigation                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No Apple Developer / Google Play account yet**                                                          | **BLOCKER for shipping** | Not for building. Start it now — enrolment (esp. Apple, and DUNS for an org) can take weeks and blocks TestFlight, not code.                          |
| **CI is billing-locked** (every job rejected before its first step)                                       | HIGH                     | Mobile adds a build to a pipeline that does not run. EAS builds can be triggered manually meanwhile; the gate stays local. Unblock billing before M4. |
| **No push transport exists**                                                                              | MEDIUM                   | Scheduled as M4/§21-B. Nothing before M4 depends on it.                                                                                               |
| **Timezone defect (C)** surfaces harder on mobile — device zone ≠ hospital zone is the norm, not the edge | MEDIUM                   | Fix before M2; §14 forbids mobile from inventing semantics in the meantime.                                                                           |
| **Local Docker OOM kills Mongo** during integration runs                                                  | MEDIUM                   | Known, documented, one-line diagnosis (`OOMKilled`). Give Docker more memory before the mobile suites lengthen the run.                               |
| **No realtime (ADR-0008 unbuilt)**                                                                        | LOW-MED                  | Queues and boards poll. Acceptable for M1–M6; revisit with chat.                                                                                      |
| **iOS cannot prevent screenshots**                                                                        | LOW-MED                  | Detect + log + notice. Stated plainly rather than assured away.                                                                                       |
| **Base64 uploads cap ~15 MB**                                                                             | LOW                      | Client-side compression; a multipart/presigned path is a later decision, not a storage-provider change.                                               |
| **OTA used to route around review**                                                                       | LOW, high impact         | The §17 policy is the control: clinical and money logic go through the store.                                                                         |
| **Divergence from the web's state model**                                                                 | LOW                      | Mobile implements what Doc 04 §3.1 already mandates; the web is the one that owes a catch-up (D4).                                                    |
| **Scope creep into 50 screens**                                                                           | MEDIUM                   | §18's "deliberately NOT on mobile" column is the defence. One role per phase, shippable.                                                              |

---

## Decision summary

**Expo · Expo Router · TanStack Query + Zustand · `@medicore/api-client` unforked · secure-store
tokens · permission-derived navigation · server-authoritative branch · no offline clinical writes ·
push designed and deferred to M4 · four backend items, two of them pre-existing defects.**

**Nothing in M1 requires a backend change.**
