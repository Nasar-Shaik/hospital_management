# Communication policy — which channel carries which message

**Status: decided, 2026-08-18.** This exists because the most urgent message in the product was
delivered to a channel that is switched off in a default deployment, and every part of the
machinery around it worked perfectly.

---

## The rule, in one line

**Who the message is FOR decides the channel.** Staff have a login, so the ledger row is the
delivery. Patients do not, so the message has to leave the building.

| Template                   | Audience | Channel | Why                                                     |
| -------------------------- | -------- | ------- | ------------------------------------------------------- |
| `order.critical`           | Staff    | `inapp` | Cannot be unreachable; needs nothing configured         |
| `order.result.released`    | Staff    | `inapp` | Same, and it is only actionable in the chart anyway     |
| `password.reset`           | Staff    | `email` | **The exception.** They cannot sign in to read an inbox |
| `patient.welcome`          | Patient  | `email` | No login, no app                                        |
| `appointment.confirmation` | Patient  | `email` | ″                                                       |
| `appointment.reminder`     | Patient  | `email` | ″                                                       |
| `appointment.cancellation` | Patient  | `email` | ″                                                       |

---

## What was wrong

`raiseCriticalAlert()` in `orders/order.service.ts` is the most carefully written function in the
repository. It is sent **inline**, not through the outbox, because _"durable and fast are different
promises… unconscionable for a potassium of 7.2"_. It is deduped per order. It reads `notify()`'s
**outcome** rather than assuming success, specifically so that a failed alert can never be logged
as a successful one.

It rendered an `email` template. `email.isEnabled()` is `env.NOTIFY_EMAIL_ENABLED &&
Boolean(env.SMTP_HOST)`. With no SMTP host — the default on a fresh deployment — the outcome it
faithfully reported was `suppressed`, and the alert reached nobody.

The in-app channel had been registered and idle since Phase 1. Its own docstring described an
inbox route (`GET /notifications/me`) that did not exist; the mobile app's Alerts tab named the
same missing route as its blocker. Migration 0011 had already built the per-recipient index.
Everything was in place except the last hop.

## What changed

- `GET /notifications/me` and `POST /notifications/:id/read` — authenticated, **unpermissioned**,
  recipient taken from the session (migration 0050).
- The two staff templates moved to `inapp` in the seed **and** by migration 0051, because the seed
  writes `$setOnInsert` and would otherwise have fixed nothing for any existing hospital.

## What the inbox deliberately does not do

**It is not branch-scoped.** Every other clinical read narrows to the active branch; this one must
not. A message is addressed to a person, not a site, and a consultant who switches the branch
picker to look at another site must not thereby lose the critical potassium raised twenty minutes
ago at the first one. `branchId` is recorded on the row and shown on screen — it is not a filter.

**It shows `sent` messages only.** The ledger records every attempt, including the ones that went
nowhere. Listing a `suppressed` row in somebody's inbox would deliver, after the fact, a message
the system already recorded as withheld, and would put a read receipt on it. Suppressed messages
belong on `GET /notifications?status=suppressed`, which is the administrator's screen because the
administrator is the one who can fix the cause.

**It carries its own shape**, not the ledger record's. `to`, `dedupeKey`, `attempts`, `status`,
`error` and `recipientId` answer an operator's question and are not the reader's business — and
this route has no permission in front of it, so the smaller the surface the better.

---

## The open decision: should a critical result ALSO go by email?

Almost certainly yes, and it is not free.

`dedupeKey` is unique per tenant (`one_message_per_cause`, migration 0011). Two channels for one
cause therefore **collide, and the second is silently recorded as a duplicate** — the failure mode
is that the hospital believes it has belt and braces and has only a belt. Doing it properly means
the key gains the channel (`order.critical:{orderId}:email`), which is a caller change and keeps
exactly-once per channel.

The two positions:

1. **Send both.** An email reaches a consultant who is not logged in; an in-app badge does not.
   For the one message whose entire purpose is to make somebody act within minutes, redundancy is
   the point.
2. **Send one and make it reliable.** Two copies of an urgent message train people to ignore one
   of them, and the hospital that wants email can be given the lever instead.

Whoever decides should also decide whether the CHANNEL becomes editable. It is not today:
`updateTemplate` accepts `subject`, `body` and `enabled`, so moving a template between channels is
a seed value plus a migration. If it is opened up, it must validate against the **registered**
channels rather than the enum — `NOTIFICATION_CHANNELS` lists `sms`, `whatsapp` and `push`, none
of which have a transport, and pointing a template at one would make `notify()` return `failed`
and send nothing.

## Push shipped as a FAN-OUT, not a channel (M4, 2026-08-20)

The section above is the reason. A `push` channel would have hit exactly the collision it
describes: one cause, two channels, one `dedupeKey`, and the second message silently recorded as a
duplicate.

Push is not a second message. `channels/inapp.ts` has said what it is since it was written — _"a
phone notification is a push wrapper around one of these rows, not a separate system"_ — so the
in-app row is claimed, rendered, sent and left authoritative, and `notification.service.ts` then
queues `push.deliver` for it. One row per cause, unchanged. An Expo outage costs a buzz and never
an alert, which is also why the fan-out is best-effort and cannot fail the message.

Two consequences worth stating plainly:

- **The `inapp` channel is the eligibility rule.** That channel carries the staff messages BECAUSE
  only staff have logins, so a patient — no app, no login, no device row — is excluded by
  construction rather than by a check somebody has to remember (`shouldPush`, pinned in
  `pushCopy.test.ts`).
- **The push carries no identifiers.** Not the rendered subject, which reads "CRITICAL RESULT —
  Kamala Devi — Serum Potassium" and would put a name, a test and a diagnosis-shaped fact on a
  locked handset. A fixed line per template says what happened; the ids ride in the undisplayed
  `data` payload and the app reads the real message from the ledger after unlock. An unclassified
  template falls back to "You have a new alert", so the cost of forgetting one is silence, not
  disclosure.

The email question above is still open and is unaffected: it is about a second CHANNEL for one
cause, which push deliberately is not.

## Not built, deliberately

SMS and WhatsApp (a paid gateway), staff chat and broadcast, a patient-facing inbox, real-time
sockets, per-user notification preferences, quiet hours and digests.

There is still no `POST /notifications`, and that absence is deliberate: _"a general 'send an
arbitrary message to an arbitrary person' endpoint is a spam cannon with a REST interface"_
(`notification.routes.ts`). Messages are sent by the domain, in response to something that
happened.

---

## What the tests prove

| Claim                                                         | Where                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------- |
| A person sees their own messages and nobody else's            | `notifications.int.test.ts` — the inbox block            |
| An admin holding every permission cannot open somebody's mail | same block, `refuses to open somebody else's message`    |
| A critical alert lands with no SMTP configured at all         | same block, `arrives with no mail server configured`     |
| The first read time survives a second click                   | same block, `keeps the time a message was FIRST opened`  |
| Patient templates stayed on email                             | same block, `patient messages still leave the building`  |
| An existing hospital's templates are re-pointed               | migration 0051, exercised by every suite that provisions |
| The inbox is not narrowed by the branch picker                | `branchIsolation.int.test.ts`                            |
