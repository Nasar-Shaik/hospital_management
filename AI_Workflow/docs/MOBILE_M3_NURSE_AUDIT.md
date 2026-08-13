# M3 — NURSE MOBILE: BACKEND & SYSTEM AUDIT

**Date:** 2026-08-13 · **Status:** audit complete. **G1 and G2 are CLOSED by M3-S1**; G3–G6 remain.

> **S2 amendment — the ±4h slot tolerance was a duplicate-administration escape path.** S1 bound an
> administration to a dose slot only within half the neighbouring gap, capped at four hours, and
> recorded anything further out with NO slot — reasoning that back-charting is not a slot event.
> That left the exact defect S1 closed, displaced in time: a TDS line's smallest gap is 6h, so the
> tolerance was 3h, and a night nurse charting the 20:00 dose at 02:00 bound nothing. Two nurses
> could each do it and each get a `given` row. **Proved with a probe before changing anything.**
> The cap was not the whole bug either — `min(...gaps)` measured the overnight stretch with the
> daytime spacing, so widening the cap would only have moved the dead zone. The tolerance is now
> gone entirely: the nearest dose wins, ties go to the earlier one, and `undefined` means only
> "there are no scheduled doses near this at all" (PRN, or a finished course).
>
> **S1 amendment (recorded because the audit predicted the wrong key).** §11 B2 below proposed
> `{tenantId, prescriptionId, drugCode, scheduledFor}` as the dose-slot identity. That is wrong.
> `prescription.schema.ts` places no uniqueness rule on `lines`, so one prescription may carry the
> same drug twice — paracetamol QID on the round and paracetamol SOS for breakthrough fever — and
> keying on the code would merge a scheduled line with a PRN one. Prescription lines have
> `{ _id: false }`, so there is no stored line id either.
>
> **The shipped key is `{tenantId, prescriptionId, lineIndex, scheduledFor}`.** A line's POSITION
> is a safe identity because a signed prescription's `lines` array is immutable — `updateDraftLines`
> filters on `status: "draft"`, and an amendment supersedes rather than edits. That also meant no
> `_id` had to be backfilled into historical prescriptions, i.e. no rewriting of signed legal
> instruments to fix a MAR bug. The old `lines.find(l => l.drugCode === code)` took the FIRST match
> and was itself a latent defect; it now refuses an ambiguous code instead.

> **Headline: the M0 phase table says M3 needs "Backend needed: none". That is wrong.**
> Four backend gaps stand between today's API and a safe nurse workflow, and one of them
> — **nothing anywhere prevents the same dose being charted twice** — is a clinical safety
> defect that exists in the shipped product right now, independent of mobile.

---

## 1. M3 capability matrix

| Capability                | Backend today                                         | Verdict                    |
| ------------------------- | ----------------------------------------------------- | -------------------------- |
| Ward worklist             | `GET /inpatients` — paged, branch-scoped              | **usable**, no ward filter |
| Patient identity / chart  | patients, encounters, timeline                        | **usable** (M2 proved it)  |
| Allergies — read          | `GET /patients/:id/allergies`, `allergy:read`         | **usable**                 |
| Allergies — record/refute | `POST` ×2, `allergy:manage`                           | **gap** — not idempotent   |
| Vitals — read             | `GET` by encounter and by patient, `emr:read`         | **usable**                 |
| Vitals — record           | `POST`, `vitals:record`, **idempotent**, server flags | **usable as-is**           |
| Medication list (ordered) | prescriptions, `emr:read`                             | **usable**                 |
| Medication **due** list   | —                                                     | **MISSING ENTIRELY**       |
| MAR — read                | `GET /encounters/:id/medication-administrations`      | **usable**                 |
| MAR — administer          | `POST`, `mar:administer`, `Idempotency-Key` honoured  | **UNSAFE** — see §5, §8    |
| Nursing notes             | ward notes exist, gated `emr:write`                   | **BLOCKED** — nurse can't  |
| Nursing tasks / care plan | —                                                     | absent; out of M3 scope    |
| Handover                  | —                                                     | derive, don't build (§12)  |
| Intake / output, wounds   | —                                                     | absent; out of M3 scope    |

---

## 2. Backend endpoint inventory (nurse-reachable)

| Method | Path                                             | Permission       | Feature flag | Idempotent |
| ------ | ------------------------------------------------ | ---------------- | ------------ | ---------- |
| GET    | `/inpatients`                                    | `encounter:read` | `ops.ipd`    | n/a        |
| GET    | `/bed-board`                                     | `emr:read`       | `ops.ipd`    | n/a        |
| GET    | `/encounters/:id`, `/encounters/:id/timeline`    | `emr:read`       | —            | n/a        |
| GET    | `/patients/:id`                                  | `patient:read`   | —            | n/a        |
| GET    | `/patients/:id/allergies`                        | `allergy:read`   | —            | n/a        |
| POST   | `/patients/:id/allergies`                        | `allergy:manage` | —            | **no**     |
| POST   | `/allergies/:id/refute`                          | `allergy:manage` | —            | **no**     |
| GET    | `/encounters/:id/vitals`, `/patients/:id/vitals` | `emr:read`       | —            | n/a        |
| POST   | `/encounters/:id/vitals`                         | `vitals:record`  | —            | **yes**    |
| GET    | `/encounters/:id/prescriptions`                  | `emr:read`       | `clinical.*` | n/a        |
| GET    | `/encounters/:id/medication-administrations`     | `emr:read`       | `nursing`    | n/a        |
| POST   | `/encounters/:id/medication-administrations`     | `mar:administer` | `nursing`    | **yes\***  |
| GET    | `/encounters/:id/notes`                          | `emr:read`       | `ops.ipd`    | n/a        |
| POST   | `/encounters/:id/notes`                          | `emr:write`      | `ops.ipd`    | yes        |

\* `Idempotency-Key` dedupes **one client retrying**. It does nothing about **two nurses**. See §8.

---

## 3. Permissions matrix

NURSE holds **19** permissions (computed from `DEFAULT_ROLES`, not eyeballed):

```
patient:read      encounter:read    encounter:update  record:read
consent:manage    emr:read          vitals:record     allergy:read
allergy:manage    nursing:manage    mar:administer    lab:collect
order:read        order:perform     bed:allocate      mortuary:manage
mortuary:release  appointment:read  file:read
```

### Three defects in that set

1. **`nursing:manage` gates ZERO routes.** Granted to NURSE with the comment "nursing notes",
   and there is no route in the codebase that requires it. A permission nobody's request ever
   reaches is a feature nobody has.
2. **`lab:collect` gates ZERO routes.** Same class. Out of M3 scope — recorded, not fixed.
3. **NURSE does not hold `emr:write`**, which is what `POST /encounters/:id/notes` requires.
   **A nurse cannot write a nursing note today.** M3 §8 is blocked on this.

The fix is not to grant `emr:write` — that would also let a nurse write a **discharge summary**
and an **outcome note** (both are `WARD_NOTE_TYPES` on the same endpoint). See §11.

---

## 4. Data model & state machines

### Prescription line — the medication order

```
drugCode · drugName · dose · route(enum, 11) · frequency(enum, 11) · durationDays? · quantity
```

`frequency ∈ {OD, BD, TDS, QID, HS, SOS, STAT, Q4H, Q6H, Q8H, WEEKLY}` — an **abbreviation**,
not a schedule. Nothing in the repository converts it into clock times. Verified: a search for
`scheduledFor|scheduledAt|doseDue|medicationsDue|dueAt` across `apps/api` and `packages`
returns **nothing**.

### MAR row — the administration

```
encounterId · patientId · prescriptionId · drugCode · drugName · dose · route
status ∈ {given, held, refused, not_available} · administeredAt · reason? · note?
administeredBy (= ctx.userId) · branchId
```

**`status` is an outcome, not a lifecycle** — there is no state machine, because a MAR row is
append-only and terminal on creation. That is correct and should not change.

**There is no `omitted` status, and there should not be one.** The model's own header states the
design: _"a blank in the MAR is a question, a recorded `held`/`refused` is an answer."_ A missed
dose is the **absence** of a row against a scheduled slot. Adding `omitted` would create two
representations of one fact. What is missing is not the status — it is the **slot** whose absence
can be noticed.

### The missing link, stated plainly

```
PRESCRIPTION LINE            ???              MAR ROW
"Amoxicillin TDS × 5d"   ──────────▶   "given at 14:03 by nurse X"
                          no schedule
                          no due list
                          no slot identity
                          no way to notice a miss
                          no way to detect a double
```

---

## 5. Idempotency & reconciliation

| Write          | Mechanism      | Retry-safe? | Reconciliation oracle    |
| -------------- | -------------- | ----------- | ------------------------ |
| Vitals         | `idempotent()` | yes         | key replay               |
| Ward note      | `idempotent()` | yes         | key replay (M2 hardened) |
| MAR administer | `idempotent()` | **partial** | **none**                 |
| Allergy record | —              | **no**      | none                     |
| Allergy refute | —              | (naturally) | terminal state           |

**Why MAR is only "partial":** `Idempotency-Key` is a _client-side_ promise. It protects one
device replaying one request. It cannot protect against:

- the same nurse retrying from a **fresh key** after an app restart,
- **a second nurse** on a second phone charting the same dose,
- a response lost after commit where the client generates a new key on retry.

And because there is no slot identity, there is **no server state a client could query to find
out whether the dose it just tried to chart actually landed**. There is nothing to reconcile
_against_. This is the difference between MAR and every other clinical write M2 hardened —
prescriptions had `signedAt` as an oracle; the MAR has nothing.

---

## 6. Branch isolation

Sound, with one deliberate exception.

- MAR: `scopeFilter()` on read, `writeBranchId()` on write. Correct.
- Vitals, ward notes, encounters, inpatients: branch-scoped. Correct.
- **Allergies are hospital-wide by design** — the api-client says so explicitly: _"Read
  hospital-wide, never branch-scoped."_ This is right (an allergy does not stop at a building)
  and must be **preserved**, not "fixed". It means the mobile query key for allergies is keyed on
  tenant + patient, **not** branch — and the branch-isolation test must assert that a patient's
  allergies _do_ survive a branch switch, while their vitals and MAR do not.

---

## 7. Timezone

`core/time` primitives exist (`dayKeyInZone`, `dayRangeInZone`, `zoneOrDefault`) and were wired
into appointments in `22163c2`. Nurse-facing state today:

- Vitals, MAR, notes store **UTC instants**. Correct.
- No nurse-facing endpoint derives a **day** or a **due time**, so there is nothing to get wrong
  yet — the timezone risk in M3 is **entirely in the code that does not exist**.
- **The dose schedule must therefore be born correct.** "Is the 08:00 dose due?" is exactly the
  device-timezone trap: a nurse in a branch two zones from the server, or a phone with the wrong
  clock, must not change what is due. Dose times resolve in the **branch** zone, server-side, and
  the phone renders what the server says.
- `vitest.config.ts` pins `TZ: "Asia/Kolkata"` in the test suite — the M3 schedule suite must put
  the branch several hours from that pin, as `appointments.tz.int.test.ts` does.

---

## 8. Concurrency risks

### THE FINDING — duplicate administration is possible today

`medicationAdministrations` has exactly two indexes, both from migration `0040`:

```
{ tenantId, encounterId, administeredAt: -1 }    non-unique
{ tenantId, prescriptionId }                      non-unique
```

**There is no uniqueness constraint at any layer.** Not in the index, not in the model, not in
the service, not in the repository. `recordAdministration` validates that the prescription is
real, signed, for this encounter, and that the drug is a line on it — and then writes a row,
unconditionally, however many times it is asked to.

Two nurses on two phones both charting the 14:00 antibiotic produce **two `given` rows**. The
chart then reads as a double dose administered. Nothing flags it, nothing rejects it, and because
the MAR is append-only neither row can be withdrawn.

**This is a clinical safety defect in the shipped product.** It is not caused by mobile and it is
not fixed by anything mobile could do. Per §28 of the work order and §19's "do not solve database
integrity with frontend checks", it is fixed in the database.

Other concurrency, for completeness:

| Race                              | Today                         | Verdict             |
| --------------------------------- | ----------------------------- | ------------------- |
| Two nurses, same dose             | two rows, silent              | **must fix**        |
| Two nurses, vitals                | two readings                  | fine — both real    |
| Two nurses, same allergy          | duplicate allergy rows        | fix via idempotency |
| Allergy refuted mid-screen        | refute is terminal, converges | fine                |
| Prescription cancelled mid-screen | service rejects on status     | **already correct** |

---

## 9. Audit / medico-legal

Good news, verified rather than assumed:

- `marSchema.plugin(auditPlugin, { resource: "medicationAdministration", category: "phi" })`.
- `administeredBy` **is** populated, from `ctx.userId` in the repository (not the service — worth
  knowing, because the service's `record()` call does not mention it and reads as if it were
  missing).
- Ward notes carry `authorId`; note text is excluded from the audit diff deliberately.

Gap: **a duplicate administration is itself the medico-legal risk.** Two audited rows, both
correctly attributed, both wrong about what happened to the patient.

---

## 10. API gaps discovered

| #   | Gap                                                        | Severity        |
| --- | ---------------------------------------------------------- | --------------- |
| G1  | No medication schedule / due list — the nurse's core view  | **CLOSED (S1)** |
| G2  | No uniqueness on administration → double-charting possible | **CLOSED (S1)** |
| G3  | Nurse cannot write a nursing note (`emr:write` not held)   | **blocking**    |
| G4  | Allergy writes are not idempotent                          | moderate        |
| G5  | `nursing:manage` and `lab:collect` gate zero routes        | latent          |
| G6  | `/inpatients` has no ward filter; no nurse↔ward assignment | accepted        |

---

## 11. Backend changes required

### B1 — Dose schedule, COMPUTED (closes G1)

Follows the precedent `slots.ts` already sets for appointments, in its own words: _"Slots are
COMPUTED, never stored. A stored slot table would be millions of rows describing something a
single row already says."_ The same is true of doses, and more so — a stored schedule would drift
the moment a prescription was changed or stopped.

```
dosesFor(prescriptionLine, signedAt, dayKey, branchZone) → ScheduledDose[]
```

- Standard drug-round times **in branch-local wall clock**: `OD 08:00` · `BD 08:00,20:00` ·
  `TDS 08:00,14:00,20:00` · `QID 06:00,12:00,18:00,22:00` · `HS 22:00` · `Q4H/Q6H/Q8H` from
  midnight · `WEEKLY` on the signing weekday.
- Course window: from the prescription's `signedAt` clinic-day, running `durationDays`.
- **`SOS` (PRN) generates no slots** — it is given on demand, may be given many times, and is
  never "due" and never "missed".
- **`STAT` generates exactly one slot**, at signing.

New: `GET /encounters/:id/medication-schedule?date=` → each due slot with its resolved status
(`due` / `given` / `held` / `refused` / `not_available` / `missed`), joined against real MAR rows.
**This is the server-state oracle** §7 of the work order demands — the thing a client can ask
"did my dose land?" and get a truthful answer from.

### B2 — Slot identity + uniqueness (closes G2)

- `scheduledFor?: Date` on the MAR row — **additive and optional**, so PRN, STAT and
  back-charted paper rounds are unaffected.
- Migration: **unique partial index** on `{ tenantId, prescriptionId, drugCode, scheduledFor }`
  where `scheduledFor` exists. PRN rows have no `scheduledFor` and stay unconstrained, which is
  clinically correct.
- Duplicate key → **409 carrying the existing row**. That single response is simultaneously the
  duplicate guard _and_ the reconciliation answer: a client whose response was lost retries, gets
  409 + the row it already wrote, and correctly reports "already given — by whom, at what time".

The partial index is the whole fix. Two nurses, two phones, two processes: only the database can
arbitrate, and this is the layer §19 says to put it in.

### B3 — Nursing notes (closes G3, activates G5's `nursing:manage`)

- Add `"nursing"` to `WARD_NOTE_TYPES`.
- New route `POST /encounters/:id/nursing-notes`, gated on **`nursing:manage`**, forcing
  `type: "nursing"`, carrying `idempotent()` exactly as the M2 ward-note hardening did.

Why a separate route rather than relaxing the existing one: `authorize()` takes **one**
permission and the RBAC matrix suite reads those tags back off the shipped app, so the mapping is
load-bearing one-to-one. A second permission on the existing route is not expressible. And a
nurse must not reach `discharge_summary` or `outcome_note`, which the shared endpoint's body
would allow. Same reasoning as `doctor:self-manage` in `ce0c58a`.

Notes land in the **same collection**, so the chart and the handover read one timeline — M3 §3's
"do not create a second incompatible patient chart", applied to the data.

### B4 — Allergy write idempotency (closes G4)

Add `idempotent()` to both allergy POSTs. One line each, matching every other clinical write.

### Not doing, deliberately

- Nursing tasks / care plans / intake-output / wound care — no domain exists. §9 of the work
  order says not to invent a subsystem, and the roadmap does not list one.
- Handover as a subsystem — §10 says evaluate, not build. The schedule (B1) plus vitals plus
  nursing notes **is** a handover view; it needs no new storage.
- `lab:collect` — a real orphan, but LAB is M6. Recorded.
- Ward filter on `/inpatients` — additive, cheap, but there is no nurse↔ward assignment to filter
  by. Deferred with the reason.

---

## 12. Recommended slices

The work order proposed mobile-first slicing. **The audit changes the dependency order:** three of
the four gaps are backend, and mobile cannot be built against a contract that does not exist.

| Slice     | Scope                                                                |
| --------- | -------------------------------------------------------------------- |
| **M3-S1** | **Backend: the MAR safety spine.** B1 + B2. Highest risk, blocks S5. |
| **M3-S2** | **Backend: nursing notes + allergy idempotency.** B3 + B4.           |
| **M3-S3** | Mobile: nurse foundation, ward worklist, chart reuse.                |
| **M3-S4** | Mobile: vitals capture + allergies.                                  |
| **M3-S5** | Mobile: medication context + MAR administration with confirmation.   |
| **M3-S6** | Integration, concurrency, security, falsification, hardening.        |

S1 and S2 are independently releasable and **fix live defects on their own** — they are worth
shipping whether or not the nurse mobile app follows.

---

## 13. M3-S1 plan

**`fix(api): make a charted dose unique to its scheduled slot`**

1. `modules/mar/schedule.ts` — pure, no I/O: `dosesFor(line, signedAt, dayKey, zone)`.
   Unit-tested against every one of the 11 frequencies, including SOS→none and STAT→one.
2. `mar.model.ts` — `scheduledFor?: Date`.
3. Migration `00NN-mar-scheduled-slot` — the unique partial index. Plus a **pre-flight duplicate
   scan**, because a live tenant may already hold duplicates and `createIndex` would fail on
   them; the migration must report them rather than die.
4. `mar.service.ts` — resolve the branch zone, accept `scheduledFor`, validate it is a real slot
   for that line, map duplicate-key → 409 with the existing row.
5. `GET /encounters/:id/medication-schedule?date=` — controller, contract, route, OpenAPI.
6. api-client: `listMedicationSchedule`, `scheduledFor` on `recordMedicationAdministration`.
7. Tests: unit (schedule maths, all frequencies, DST-free boundary), integration (two concurrent
   administrations of one slot → exactly one 201 and one 409; PRN twice → two 201s; branch
   isolation; a branch several hours off the `TZ` pin).
8. **Falsification:** drop the unique index → concurrency test RED. Substitute the process zone
   for the branch zone → schedule test RED. Remove the 409 mapping → reconciliation test RED.

**Backward compatibility:** every change is additive. A client that never sends `scheduledFor`
behaves exactly as it does today, which keeps this inside v1 — the same rule `idempotent()` was
added under.
