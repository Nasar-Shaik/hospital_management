# Operation Theatre (B5) — what v1 is, and what it deliberately is not

**Status: v1 complete, 2026-08-19.**

---

## The workflow, in one line

**Surgeon books a theatre window → the OT list shows it → the room is started → the operation
record is written → it reaches the patient's chart.**

Four states, one collision rule, one write-once record. That is the whole module.

---

## What already existed before this milestone

Most of it. The registry, the bookings, the overlap rule, the four-state machine, the branch
stamping, the entitlement gate and the OT screen were all shipped and all correct. This milestone
did **not** rebuild any of them.

What it found instead were two holes of a kind this repository has now hit four times:

1. **`ot:schedule` was granted to no clinical role.** TENANT_ADMIN held it because TENANT_ADMIN
   holds everything; no doctor and no nurse did. Every route worked, the screen rendered, and the
   only person in the building who could put a patient on a surgical list was the hospital
   administrator. A permission nobody holds is a feature nobody has — see
   [PERMISSION_LIFECYCLE.md](./PERMISSION_LIFECYCLE.md).

2. **The operation record did not exist.** `ot:record` was declared `future` and held by DOCTOR,
   with the honest note "theatres today are a bookable resource only". A theatre you can book but
   not write up produces no clinical record of the operation, which is the one artefact the rest of
   the hospital needs.

There were also **no behavioural tests of theatres at all** — every theatre assertion in the
repository came from the RBAC matrix, which probes routes for a status code and knows nothing about
what they do. That is why the permission hole survived.

---

## The collision rule

Two procedures must not run in one theatre at once. A procedure has a **duration**, so the rule is
an overlap of windows, and an overlap of arbitrary windows is not something a unique index can
express. So it is enforced in two layers, and the module is candid about which does what:

| Layer                                                           | What it catches                           |
| --------------------------------------------------------------- | ----------------------------------------- |
| Service: `start < otherEnd && end > otherStart`                 | The real rule. Any overlapping window.    |
| Partial-unique index on `{tenantId, theatreId, scheduledStart}` | The race: two identical bookings at once. |

Both are tested, and the index is tested **concurrently** — sequentially the service check alone is
enough and the index proves nothing.

The comparison is **strict**. A list booked nose to tail all day is legal and must stay legal; a
rule written with `<=` would refuse every second case in the hospital and would look exactly like a
working overlap check on any test that only tried a real overlap.

A booking holds its window while it is `scheduled` or `in_progress`, and releases it the moment it
reaches a terminal state — so a cancelled or completed case frees the theatre for the next one.

---

## States

```
scheduled ──▶ in_progress ──▶ completed
    │              │
    └──────────────┴────────▶ cancelled
```

Four states, not ten. `completed` and `cancelled` are terminal: a finished operation cannot be
restarted and a cancelled one cannot be revived.

---

## The operation record

Written onto the booking, once, after the procedure has started.

| Field                      |                                                          |
| -------------------------- | -------------------------------------------------------- |
| `procedurePerformed`       | **Required.** What was actually done.                    |
| `surgeonId`                | **Required.** Who actually operated.                     |
| `performedAt`              | **Required.**                                            |
| `findings`, `notes`        | Optional.                                                |
| `recordedBy`, `recordedAt` | Server-set. Provenance, separate from the surgeon named. |

### Three decisions worth stating

**It restates the procedure and the surgeon rather than pointing at the booking's.** The booking
says what was _planned_; the record says what _happened_, and the two differ often enough that
collapsing them would lose the fact — a diagnostic laparoscopy becomes an appendectomy, the
consultant scrubs in for the registrar.

**It may only be written on a procedure that has started.** A note on a `scheduled` booking would
be a signed clinical statement about an operation nobody has performed; a note on a `cancelled` one
describes an operation that never happened. `in_progress` is deliberately allowed, not just
`completed` — the surgeon dictates while the patient is still in the room.

**It is write-once, enforced by the database.** The update is conditional on the note being absent
(`operativeNote: { $exists: false }`), not on a read that preceded it. A read-then-write would leave
a window in which two devices both see "no note yet" and the second silently overwrites a signed
clinical record. There is no edit path in v1 — see _Deliberately simplified_.

---

## Permissions

| Capability                    | Permission        | Held by                         |
| ----------------------------- | ----------------- | ------------------------------- |
| Read the board and registry   | `emr:read`        | Every clinical role             |
| Register / retire a theatre   | `facility:manage` | TENANT_ADMIN                    |
| Book, start, complete, cancel | `ot:schedule`     | **DOCTOR, NURSE**, TENANT_ADMIN |
| Write the operation record    | `ot:record`       | **DOCTOR**, TENANT_ADMIN        |

**Why the surgeon books.** They decide the patient needs an operation and when; the theatre is the
resource that decision consumes. `branch`-scoped, so it reaches only their own site's list.

**Why the nurse can move the list along but not write the record.** In every hospital this product
is sold to, the person who marks a case started and completed is the circulating nurse — the
surgeon is scrubbed in and nowhere near a keyboard for the hours in between. Without it the list
would sit on `scheduled` all day. What was found inside the patient is a different act by a
different person, so it is a different permission.

**Why the board is `emr:read`, and why that is not a broad grant.** A surgical list names a patient,
their operation and their surgeon — it is the chart, arranged by time. Everyone who reads it
(surgeon, ward nurse, anaesthetist) already holds `emr:read` for the same patients, so nothing was
widened to make the screen work. The alternative — inventing an "OT board read" that hands a
logistics role a list of who is having what done today — would be the broad grant, wearing a
narrow name.

---

## Entitlement

Gated on **`module.clinical.ot`**, on every route, read and write alike. Only a surgical hospital
has operating theatres; a clinic gets `HMS-PLAN-002` ("not in your edition"), which names the truth
and sends the administrator to sales rather than into the role editor for a permission that could
never help them.

Included in `PLAN_HOSPITAL` and above. **Not** in `PLAN_CLINIC`, `PLAN_CLINIC_PLUS`,
`PLAN_DIAGNOSTIC` or `PLAN_DAY_CARE`.

With the flag off, the theatre screen's routes all answer 403 and the doctor's chart simply shows
no Procedures section — a hospital that does not operate is not shown an empty theatre.

---

## Billing — a dependency, not a second system

**Nothing was built here, deliberately.** Procedure charges already exist and already work:

```
doctor orders a `procedure` (order category) → order.placed → billing prices it from the tariff
```

`chargeCategoryFor` maps the order category to a `procedure` charge, the tariff seeds `DRESS`,
`INJ` and `NEB`, and the doctor's order pad already offers every `procedure` service item. An OT
booking is **scheduling**, not a charge: it consumes a room, and the room is not what the patient
is billed for.

So the dependency is stated rather than wired: **a hospital that wants an operation on the bill
places a `procedure` order for it, exactly as it would for any other billable service.** Wiring the
booking directly to `postCharge` would mean a second path into billing that prices a free-text
`procedureName` with no tariff code behind it — a line item for an unknown amount, which is how
`onOrderPlaced` came to need its explicit pharmacy exception.

Linking a booking to the procedure order that pays for it is a reasonable v2; it is not needed to
run a theatre.

---

## Deliberately simplified

Named so nobody has to guess whether they were forgotten:

| Not built                                               | Why                                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Amending an operation record                            | The honest version keeps the original visible alongside the amendment. That is a real feature, not a checkbox, and v1 does not need it. |
| Pre-operative checklist / WHO surgical safety checklist | A checklist that nobody is required to complete is theatre; one that blocks the list is a workflow engine.                              |
| Anaesthesia record, anaesthetist assignment             | A second clinical record with its own author and lifecycle.                                                                             |
| Surgical team roster (assistants, scrub nurse)          | The record names the operating surgeon. The rest is a roster module.                                                                    |
| Instrument / implant tracking, CSSD, OT inventory       | Inventory, and the pharmacy milestone showed how much of it is real work.                                                               |
| PACU, blood management, consumables                     | Each is a module.                                                                                                                       |
| Theatre utilisation analytics, scheduling optimisation  | Reporting on a module that has just started collecting data.                                                                            |

The model is shaped so each can be added without moving what exists: the record is a subdocument on
the booking, not a table other things point at.

---

## Where it appears

| Screen                          | What it does                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `/theatres`                     | The day's list and the registry. Book, start, complete, cancel, write and read the record. |
| `/my-patients` → **Procedures** | The patient's whole surgical history, with each record. Rendered only when they have one.  |

The chart read is the same endpoint as the board (`GET /ot-bookings`), asked a different question:
naming a `patientId` drops the date window, because clipping a patient's surgical history to today
would hide every operation they have ever had — and look exactly like a patient who has never been
operated on.

---

## Tests

| Suite                                       | Count | What it holds                                                                                       |
| ------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------- |
| `apps/api/src/theatres.int.test.ts`         | 47    | Overlap (incl. boundaries + concurrency), state machine, the record, tenant/branch/RBAC/entitlement |
| `apps/web/__tests__/operativeNote.test.tsx` | 6     | Which request leaves the browser, and what a reader without `ot:record` is shown                    |
| `e2e/theatreWorkflow.spec.ts`               | 2     | Book → refused overlap → start → record → complete → read it back, in a real browser                |

Twelve deliberate falsifications were run against the integration suite (overlap removed, adjacency
made inclusive, state machine opened, record status guard removed, write-once removed, row scope
removed from both reads, the chart window leak, the record's permission swapped, the entitlement
dropped, the inactive-theatre refusal removed, and the surgeon's `ot:schedule` grant withdrawn).
All twelve turned the suite red.

One weak test was found and fixed by that process: the branch-isolation assertion relied on a row
created by an earlier `describe`, so it passed when run alone with `scopeFilter()` deleted from the
board query. It now creates both rows itself.
