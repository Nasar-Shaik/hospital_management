# Emergency Department (D10) — what v1 is, and what it deliberately is not

**Status: v1 complete, 2026-08-19. Re-audited against the practical workflow (C2) the same day —
the module was found sufficient; one board column was added and nothing else changed.**

---

## The workflow, in one line

**Patient arrives → registered as an emergency → triaged → ranked on the board → sent to a doctor →
worked up on the ordinary clinical screens → discharged, admitted, or sent to another hospital.**

Every step except triage and the board is a route that already existed.

---

## The one thing to understand about this module

**The ED is not a second hospital. It is a way in.**

An emergency arrival is an **encounter** — `origin: "emergency"`, `class: "ER"` — and both of those
were in `encounter.model.ts` long before this module. The lifecycle an ED patient walks is the
encounter's own:

```
arrived ──▶ in_queue ──▶ in_progress ──▶ awaiting_results ──▶ closed
                                     └────────────────────▶ admitted
```

which is exactly _arrived → triaged → with a doctor → treatment → disposition_, wearing the names
the rest of the hospital already uses. An ED-specific copy would mean two lifecycles for one
patient, and the board would be a report on whichever was written to last.

So this module owns **two things**, and nothing else:

1. **The triage record** — how sick the patient is, judged by a named person at a stated time. The
   encounter cannot carry that, because priority is not a property of arriving.
2. **The board** — all of it, ranked.

Orders, prescriptions, imaging, vitals, admission and discharge are the modules that already own
them, reached through the same routes as every other patient. An integration test drives an ED lab
order and asserts it lands on the ordinary bench; that test exists so nobody can quietly add
`POST /emergency/orders` without something turning red.

---

## What was already there

|                                         |                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `origin: "emergency"` · `class: "ER"`   | Existed. Registration needed no change beyond a checkbox.                          |
| The full state machine                  | Existed, and covers the whole ED journey.                                          |
| `WARD_KINDS` includes `emergency`       | An ER bay is a bed, owned by the ward inventory (B4).                              |
| `ORDER_PRIORITIES` includes `emergency` | The bench already sorts an ED order to the top.                                    |
| Billing on arrival                      | `onEncounterStarted` posts the consultation charge for an ER visit like any other. |
| `module.clinical.emergency`             | **Gated nothing.**                                                                 |
| `triage:perform`, `ed:board:manage`     | Declared `future`, held by nobody.                                                 |

---

## What was actually missing

**The entitlement was being sold and enforced nowhere.** The flag has been in every hospital edition
since the plans were written and no route referenced it — the third capability this repository has
found sold and ungated (see [PERMISSION_LIFECYCLE.md](./PERMISSION_LIFECYCLE.md)). The routes that
_are_ the department now ask for it.

**There was no way to say how sick somebody is**, and therefore no board.

---

## Triage

Three levels: `critical`, `urgent`, `non_urgent`.

Five-level scales (ESI, Manchester, CTAS) are real, and they are **trained instruments** — a nurse
who has not been taught the algorithm produces noise on a five-point scale, and noise ranked by
number looks exactly like signal. Three levels ask a question anybody at an ED door can answer
honestly: does this person need someone _now_, _soon_, or can they wait? A hospital that outgrows it
has trained its staff on a scale, and adding one then is a migration on a column.

**Re-triage revises; it does not repeat.** A waiting patient who deteriorates is moved up, on the
same row — enforced by a unique key on `{tenantId, encounterId}` and an upsert rather than a
read-then-write, so two devices racing converge on one record. The re-triage history is the audit
log, which already records every field change with its actor; a second history array beside it would
be the same facts written twice, drifting.

> **This claim was false for the first three weeks of the module, and is now enforced.** Because
> `recordTriage` is an upsert, the FIRST triage of a patient produced no audit entry at all — the
> plugin's query path discarded any write it had found no pre-image for, so only a _re_-triage was
> recorded (risk register **D17**, found by Stage A manual validation on 2026-08-19). The history
> this paragraph points at therefore began at the second assessment, and for the common case —
> triaged once, never revised — it did not exist. Fixed platform-wide on 2026-08-19: **an audited
> first write performed through an upsert is recorded as a CREATE, and later mutations as UPDATEs.**
> Pinned by `auditPlugin.int.test.ts`, which asserts the create/update pair on this exact flow.

**Triage does not move the encounter.** Priority is a property of the patient; the queue is a
property of the visit. Coupling them would mean a re-triage dragged a patient back out of the
consulting room. Sending the patient to a doctor is a separate act with its own button, calling the
same `POST /encounters/:id/queue` the front desk uses.

---

## The board

`GET /emergency/board` — every **open** `ER`-class encounter at the caller's scope, ranked.

### Untriaged sorts to the top

The one ordering rule here that is a safety claim rather than a convenience:

```
rank 0  not triaged yet
rank 1  critical
rank 2  urgent
rank 3  non_urgent
```

An unassessed patient's severity is not low — it is **unknown**, and unknown treated as low is the
failure mode that leaves people in waiting rooms. The board also says `Not triaged` in a red badge
rather than leaving the cell blank: an empty cell reads as _nothing to worry about here_.

### Three smaller decisions

**No date filter.** An ED does not have days. A patient brought in at 23:50 is still there at 00:10,
and a board that reset at midnight would drop the night shift's sickest patient off the screen. The
filter is the encounter being open.

**The wait is computed on the server.** A browser subtracting `arrivedAt` from its own clock reports
the wait as _that device_ sees it, and a wall-mounted board with a drifting clock then disagrees
with the nurse's phone about how long somebody has been waiting.

**Polling, not sockets.** Fifteen seconds. A socket would be a second transport to secure, scope to
a tenant and reason about on a hospital network, to make a board a person reads every minute or so
refresh in one second instead of fifteen.

---

## Disposition

| Outcome                     | How                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Discharged**              | `POST /encounters/:id/close` — the existing route.                                                             |
| **Admitted**                | `POST /encounters/:id/admit` — the existing route. A new IP encounter opens in the same episode (ADR-0013 §4). |
| **Left without being seen** | `POST /encounters/:id/left` — the existing route.                                                              |
| **Transferred out**         | `POST /emergency/transfer-out` — **the only one that needed building.**                                        |

The encounter has no word for _sent to another hospital_. `closed` says the visit ended; it does not
say the patient left in an ambulance for a facility with a cath lab, and that is the single most
important line in the record when it happens. So the transfer records the destination **first**,
then closes the visit — in that order, because if the close fails the department still has a record
of where the patient went, and the reverse would leave a visit closed with no explanation, read
forever after as _went home_.

### The state-machine gap this found

`arrived → closed` is not a legal edge, deliberately: closing a visit asserts the consultation
happened. But an ED patient _can_ leave without reaching a queue — a crash victim diverted on sight.
Both obvious fixes are wrong:

- `left_without_being_seen` means _the patient gave up and went home_. Filing a diverted trauma case
  under it corrupts the LWBS rate, which is one of the few numbers that predicts a patient coming
  back sicker.
- Adding `arrived → closed` to the shared machine would let **any** outpatient visit be closed
  without a consultation, everywhere in the product, to solve an ED problem.

So the transfer walks the visit the legal way (`in_progress`, then `closed`), and the walk is true:
the route needs `encounter:close`, which the doctor holds, and a doctor deciding to divert a patient
has assessed them.

---

## Permissions

| Capability         | Permission         | Held by                         |
| ------------------ | ------------------ | ------------------------------- |
| Read the board     | `encounter:read`   | Everyone who reads the queue    |
| Triage / re-triage | `triage:perform`   | **NURSE, DOCTOR**, TENANT_ADMIN |
| Send to a doctor   | `encounter:update` | Nurse, desk, doctor             |
| Transfer out       | `encounter:close`  | DOCTOR, TENANT_ADMIN            |

**Why the board needs no permission of its own.** It is the queue, filtered and ranked. Everyone who
reads it — the ED nurse, the doctor, the desk answering _where is my father_ twenty times a shift —
already holds `encounter:read` for the same patients. A dedicated "ED board read" would have to be
granted to exactly that set and would buy nothing. `ed:board:manage` therefore stays declared
`future`, with its reason **rewritten** to say what is actually unbuilt: bay assignment and manual
re-ordering. The ledger test can see a `future` permission that has acquired a route; it cannot see
a reason that has quietly become untrue.

**Why triage is its own permission.** Deciding how sick somebody is is a clinical judgement, not
queue management. The registration desk holds `encounter:update` and moves patients along; it must
not be able to declare one `non_urgent`.

---

## Entitlement

Gated on **`module.clinical.emergency`** — the board, triage and transfer-out all answer
`HMS-PLAN-002` without it. In `PLAN_HOSPITAL` and above.

**What stays core, deliberately:** registering a visit with `origin: "emergency"` / `class: "ER"`.
Those are _descriptions of how a patient arrived_, they predate this module, and a clinic recording
"came in as an emergency" on a walk-in is telling the truth about its afternoon. Taking that away to
make a licensing boundary tidy would break existing data for no revenue. The licensed thing is the
**department** — the assessment, the ranking, the transfer record — not the vocabulary.

---

## Billing

**Nothing was built.** An ER encounter already earns a consultation charge on arrival through
`onEncounterStarted`, and everything ordered in the ED is charged by the module that owns it — the
lab order at placement, the drug at dispensing, the bed from admission. There is no emergency
pricing, and adding one would be a second billing path for the same events.

---

## Notifications — evaluated, and not built

Communication v1 can deliver an alert. It is not used here, and that is a decision rather than an
omission.

"A critical patient has just arrived" is addressed to **a role in a room**, not to a person. At
triage no doctor is assigned — the board is a pool — so there is nobody to send it to, and inventing
a rule ("tell every doctor at this branch") would be a broadcast, which is explicitly out of scope
and is the same wrong shape as the pharmacy low-stock alert declined in the last milestone.

More simply: **the board is the alert.** It is a screen on a wall that reorders itself, and a
notification saying _look at the board_ is worse than the board.

If ED alerting is built later, the useful one is narrower and has a real addressee: _the doctor a
patient was assigned to has not opened them in N minutes_.

---

## Deliberately simplified

| Not built                                           | Why                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A five-level triage scale (ESI/MTS/CTAS)            | A trained instrument. See above.                                                                                    |
| Bay / cubicle assignment                            | `ed:board:manage` is reserved for it. v1's board is a ranked list a person reads, not a floor plan.                 |
| Manual re-ordering of the board                     | The order is derived from the triage judgement. A drag handle would be a second, unaccountable priority.            |
| Medico-legal case (MLC) registration                | `mlc:manage` is still declared `future`. The medico-legal module (consents, police clearance) is real and separate. |
| Ambulance / referral integration                    | The transfer records _where_, not _how_. The fleet is B6 and is not wired to this.                                  |
| ED-specific observation charting, scores, protocols | Vitals already exist and work on an ED visit. Scores are clinical scoring, explicitly out of scope.                 |
| Waiting-time targets, breach alerts, ED analytics   | Reporting on a module that has just started collecting data.                                                        |
| AI triage, automated diagnosis or recommendations   | The board records a judgement a named person made and is accountable for. Software must not make that judgement.    |
| A real-time ED "command centre" (sockets, pushes)   | The board polls every 15 seconds. A second transport to secure and tenant-scope, to save fourteen seconds.          |
| An emergency billing engine                         | An ED visit is an encounter and bills like one. See "Billing" above.                                                |

---

## Where it appears

| Screen         | What it does                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/reception`   | An **Emergency arrival** checkbox. Kept apart from Normal/Express, which are a commercial choice about queue position and a surcharge — this is a statement about how the patient arrived, and a desk under pressure must not have to trade one against the other. |
| `/emergency`   | The board. Triage, re-assess, send to a doctor, transfer out. Each row names the patient, their UHID, the wait **and the time they were brought in**, the priority, **the doctor they were handed to**, and the status.                                            |
| `/my-patients` | Unchanged — the ED patient turns up in the doctor's ordinary worklist. That is the point.                                                                                                                                                                          |

---

## Tests

| Suite                                        | Count | What it holds                                                                                                                                                                                                                    |
| -------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/emergency.int.test.ts`         | 43    | Registration, triage, re-triage under concurrency, ranking, every disposition, RBAC, tenant, branch, entitlement, the branch a triage must name (D19), and that lab, imaging and prescribing all go through the ORDINARY modules |
| `apps/web/__tests__/emergencyBoard.test.tsx` | 15    | That the page renders the server's order and does not invent one; which request leaves the browser; the branch guard on a write (D19); the doctor and arrival on each row                                                        |
| `e2e/emergencyWorkflow.spec.ts`              | 5     | Desk → board → triage → doctor's ordinary screens → the board names who has them → transfer → gone                                                                                                                               |

Eleven deliberate falsifications were run against the integration suite. Ten turned it red:
untriaged ranked as low, ranking removed entirely, the board keeping dispositioned patients, the
board showing every class, row scope removed from the encounter list, the ER-only guard removed, the
transfer not closing the visit, triage dropped to the desk's permission, the entitlement removed,
and triage inserting instead of revising.

**The eleventh stayed green, and the code changed because of it.** Removing `scopeFilter()` from the
triage read failed nothing — the board's ids come from an already-scoped encounter list, so that
filter is a second lock rather than the one that matters. The unused single-record read beside it
was deleted, and the remaining filter now carries a comment saying plainly that no test can turn it
red. A guard that looks proven and is not is worse than a guard that is honestly labelled.
