# API LIFECYCLE

The compatibility promise `/api/v1` makes, what breaks it, and how an endpoint is retired.

**Binding sources:** Doc 04 §5.1 (versioning & deprecation policy) · Constitution §7 ·
ERROR_CODES · `docs/IDEMPOTENCY.md`.

> **The promise, in one sentence.** Inside a version, the API only ever gains. A client written
> against `/api/v1` on the day it shipped keeps working until that version is retired, and it is
> told — in the responses it is already receiving — before anything it depends on goes away.

The caller this exists for is not a web page that reloads on deploy. It is a **phone**: a build
installed eighteen months ago, on a device nobody will update, in a hospital that has not opened
the app store since. That build cannot be patched, cannot be surveyed, and cannot be told anything
except through the responses to the calls it is already making.

---

## 1. The surfaces

| Surface             | Version | Consumers                       | Compatibility                                                                                     |
| ------------------- | ------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/api/v1`           | v1      | web, admin, mobile, integrators | **Public contract.** Additive only.                                                               |
| `/api/platform/v1`  | v1      | the operator console only       | Additive only, same machinery. Not published to hospitals; nothing outside `apps/admin` calls it. |
| `/health`, `/ready` | none    | probes                          | Not a contract. Excluded from the spec on purpose.                                                |

`openapi.json` is generated from the shipped router (`routeInventory`), and
`openapi.baseline.json` is the **approved** contract. Moving the baseline is a deliberate,
reviewable commit — which is the property Doc 04 §5.1 asks for when it says a break ships as `/v2`.

---

## 2. Allowed inside v1 — additive only

- a **new endpoint**
- a **new optional request field** (`.optional()` in the Zod schema)
- a **new response field**
- a **new optional header** the server honours but does not demand — `Idempotency-Key` is exactly
  this shape
- a **new optional query parameter**
- a **new documented status code** on an existing operation
- **relaxing** a rule: dropping a required permission, widening an enum, making a required request
  field optional, un-securing an operation

Every one of these leaves an existing caller correct without changing a line.

---

## 3. Requires v2

| Change                                         | Why it breaks                                                                                                       | Caught by `contract:check`                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Removing an endpoint                           | The call 404s.                                                                                                      | ✅ `path removed` / `operation removed`               |
| Removing a response field                      | The client reads it and gets `undefined` — usually rendering "undefined" rather than failing, which is worse.       | ✅ `response field removed`                           |
| Response field stops being guaranteed          | Same defect, arriving intermittently instead of always.                                                             | ✅ `no longer guaranteed`                             |
| Making an optional request field required      | Old clients do not send it and now fail validation.                                                                 | ✅ `became a REQUIRED request field`                  |
| Changing a field's type                        | The value stops parsing; a typed client may crash on it.                                                            | ✅ `type changed`                                     |
| Narrowing an enum                              | A value that used to be legal is refused — and the caller sending it is the one that has been correct all along.    | ✅ `enum narrowed`                                    |
| Removing a request field (strict schemas)      | `.strict()` refuses unknown keys, so an old client's payload is rejected wholesale.                                 | ✅ `request field removed`                            |
| Removing a documented status code              | An outcome the client branches on silently disappears.                                                              | ✅ `documented response N removed`                    |
| Removing or requiring a parameter              | Same two failures, in the query string.                                                                             | ✅ `parameter removed` / `became required`            |
| **Making a public operation authenticated**    | An anonymous caller is cut off, and the request itself is unchanged — so nothing in a schema diff explains the 401. | ✅ `a public operation now requires authentication`   |
| **Adding or changing a required permission**   | Every token issued before today lacks it. The user's role has not changed; the screen simply stops working.         | ✅ `now requires permission …` / `permission changed` |
| **Adding or changing a required feature flag** | A hospital that bought the old edition loses an endpoint it was using.                                              | ✅ `now requires feature …` / `feature changed`       |
| **Making `Idempotency-Key` mandatory**         | A client that never sent it starts getting 400s on the money path — the single worst place for a surprise.          | ✅ `parameter became required`                        |
| Changing what a key REPLAYS                    | A caller reconciling against a stored response gets a different one. Not schema-visible; requires a judgement call. | ❌ — see §5                                           |

The last three rows are why the authorization checks were added to `checkContract.ts` in this
milestone: the first eleven were already enforced, and "changing authentication semantics" —
explicitly a v2-class change — was invisible to the gate. All three new checks were falsified
(each mutation produced a red; each was restored).

**There is no `/v2` today, and creating one is not a refactor.** It means a second router, a second
baseline, a second client surface and a twelve-month overlap. The point of the table above is that
it should almost never be necessary.

---

## 4. Deprecation and sunset

Machinery: `apps/api/src/middleware/deprecate.ts`. **Opt-in, per operation. Nothing is deprecated
today, and `deprecation.test.ts` fails if that changes without a deliberate edit.**

```ts
deprecate({
  since: "2026-09-01",
  sunset: "2027-09-01", // ≥ 365 days after `since`, enforced at startup
  replacedBy: "/api/v1/encounters",
  note: "The visit list carries the same fields plus the branch.",
});
```

**On the wire** — every response from the operation:

```
Deprecation: @1788220800                              (RFC 9745, structured-field Item)
Sunset: Wed, 01 Sep 2027 00:00:00 GMT                 (RFC 8594, HTTP-date)
Link: <…/api/deprecations>; rel="deprecation", <…>; rel="successor-version"
```

**In the spec** — `deprecated: true`, plus `x-deprecated-since`, `x-sunset` and `x-replaced-by`,
read back from the same declaration. A document that says an endpoint is healthy while the wire
says it is going away is worse than either alone.

**In the client** — `onDeprecation(notice, path)` fires on every response carrying the headers, so
an app can log it, report it home, or show a "please update" banner. `readDeprecationHeaders()` is
exported for a caller that wants to parse them itself. The receiver shipped **before** the first
sender, deliberately: by the time we send the first `Sunset`, the builds that need to hear it are
already installed.

**The twelve-month window is enforced, not suggested.** `deprecate()` throws while the router is
being built if `sunset − since < 365 days`, so the server does not start. A promise that lives only
in prose is one somebody shortens under delivery pressure, in the release where it matters most.

### Retiring an endpoint — the sequence

1. Ship the replacement. It is additive, so it needs nothing from this document.
2. Add `deprecate()` to the old one, with `replacedBy`. Record it in `deprecation.test.ts` —
   the empty-list assertion is where the decision is written down.
3. Wait out the window. Watch for callers; the operation still works throughout.
4. On or after the sunset date, removal is a **v2 change** and needs a new version.

---

## 5. Idempotency in the lifecycle

`Idempotency-Key` is honoured on 24 operations and **required on none** — which is what keeps it
additive (Doc 04 §5.1). Making it mandatory on an existing operation is a v2 change, and
`contract:check` enforces that automatically: the header is a `required: false` parameter in the
spec, and flipping it trips `parameter became required`.

Two changes are lifecycle-relevant and **not** schema-visible, so they are judgement calls that
belong in review rather than in the gate:

- **What a replay returns.** A caller reconciling against the stored response would receive a
  different one. Treat as breaking.
- **Widening the fingerprint.** Adding an input to the hash makes yesterday's retry look like a new
  request, silently un-protecting a client that is doing everything right. Treat as breaking.

Narrowing the fingerprint, or covering a _new_ operation, is additive.

---

## 6. `requestId` — what happened to it

`requestId` predates the central mechanism: a body field on four endpoints, each with its own
guard and its own replay semantics. The decision, per module:

| Module                          | Outcome                     | Reason                                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders.requestId`              | **Keep** (internal + guard) | `prescription.consumers.ts` places a pharmacy order from a signed prescription with `requestId: rx:<id>` — there is no HTTP request there, so the header cannot reach it. At-least-once event delivery makes this dedupe load-bearing, not legacy. |
| `dispenses.requestId`           | **Keep** (guard)            | Unique index `one_dispense_per_request_id`. The header releases its claim when a handler fails; this index does not. For a controlled drug, a second handover is a diversion — two locks is the correct number.                                    |
| `invoices.payments[].requestId` | **Keep** (guard)            | Enforced inside the atomic `updateOne` filter, so it holds even if the claim was released after a partial failure. Also the only protection for a caller that sends no header.                                                                     |
| `invoices.refunds[].requestId`  | **Keep** (guard)            | Same, on the leg where a duplicate is money out of the door.                                                                                                                                                                                       |
| `billing.service` internal      | **Keep** (internal)         | `requestId: invoice:<id>:advance-settle` — a server-side dedupe with no HTTP request behind it.                                                                                                                                                    |

**Nothing was removed.** It is not deprecated either: an unused field costs nothing, and two of the
five uses have no HTTP request to attach a header to.

**It is not, and must not become, the central key.** The two have different scopes — `requestId` is
a column on one document; a claim is owned by `(tenant, user)` and replays a stored response — and
a client that assumed the body field gave it header semantics would be relying on a replay it never
gets. `mobileContract.int.test.ts` asserts this directly: a repeated body `requestId` with no header
answers from the module guard (`duplicate: true`), and creates no claim.

### The web app

All six web call sites now send `Idempotency-Key`. Where the endpoint also has a `requestId` field,
the **same string** goes in both — the header is the mechanism, the body field is the second lock
that still holds if a proxy strips an unfamiliar header.

Two of those call sites were **not idempotent at all** before this milestone. Both built their key
as `` `…-${Date.now()}` ``, so every click produced a new key and the double-click each was written
to prevent went straight through — a second lab order, a second drug handover. A key derived from
the clock protects nothing and looks exactly like a key that does.

---

## 7. What the gate enforces

| Gate             | Question                                                   |
| ---------------- | ---------------------------------------------------------- |
| `openapi:check`  | Does the committed spec match the shipped router?          |
| `contract:check` | Is the spec still compatible with the approved baseline?   |
| `client:check`   | Does `@medicore/api-client` still speak that spec exactly? |

A breaking change is therefore **impossible to make by accident and easy to make on purpose**
(`contract:accept` moves the baseline, in its own commit, with a reviewer).
