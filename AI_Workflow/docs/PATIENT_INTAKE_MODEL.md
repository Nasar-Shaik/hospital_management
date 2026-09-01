# PATIENT INTAKE — THE TWO DOORS, AND WHY BOTH EXIST

**Status:** describes what is built and running today (2026-08-13), plus the two open design debts
it exposes. Written because the question _"we already queue patients in Reception — what is
Appointments for?"_ has now been asked by someone using the product, which means the answer is not
visible in the product.

---

## 1. The model in one line

> **Reception and Appointments are not alternatives. They are the WALK-IN and the SCHEDULED door
> into the same visit, and both end at the same place: an Encounter in a doctor's queue.**

```
WALK-IN                                        SCHEDULED
Reception                                      Appointments
"patient is here now"                          "patient will come on Tuesday"
      │                                              │
      │                                    book a slot  → Appointment (requested)
      │                                              │      confirm → (confirmed)
      │                                              │
      │                                     ON THE DAY: Check in
      │                                              │
      └──────────────┬───────────────────────────────┘
                     ▼
              startEncounter()
        origin: "walk_in" | "appointment"
                     │
                     ▼
        ENCOUNTER  ── queue token ── doctor's list ── consultation ── bill
```

This is already how the code works. `checkInAppointment()` calls the same `startEncounter()` that
Reception calls, passing `origin: "appointment"` and the `appointmentId` the encounter came from
(`appointment.service.ts`). Nothing is duplicated; the appointment is a **promise of a future
encounter**, and check-in is the moment it is kept.

### Why an appointment is not simply "a queue entry with a date"

Because the two carry different information and fail differently:

|                                   | Walk-in    | Appointment                                                          |
| --------------------------------- | ---------- | -------------------------------------------------------------------- |
| Exists before the patient arrives | no         | **yes** — it is a commitment on both sides                           |
| Can be broken                     | n/a        | **yes** — `no_show`, `cancelled`, and both are reportable            |
| Occupies a doctor's time          | on arrival | **in advance**, which is what makes a slot unbookable by anyone else |
| Needs a reminder                  | no         | yes (M4 push / SMS)                                                  |
| Can be made by the patient        | no         | **yes** — see §4                                                     |

The `no_show` state is the clearest justification. A hospital cannot measure, chase, or charge for
a broken promise it never recorded, and a queue entry created on arrival has no way to represent
"this person said they would come and did not".

### The ordering rule inside check-in, which is not arbitrary

`checkInAppointment` writes the **encounter first**, then flips the appointment. The service says
why, and it is worth repeating here because it is the kind of thing that gets "tidied":

- Encounter first → a crash leaves the patient **in the queue** with the appointment still saying
  `confirmed`. They are in the building, the doctor can see them, and re-running check-in resumes
  the same encounter rather than making a second. **It converges.**
- Appointment first → a crash leaves an appointment marked `checked_in` with **nobody in the
  queue**. The desk believes the patient was dealt with; the patient is sitting in the waiting room,
  invisible. **It loses the patient.**

---

## 2. What was confusing, and what was done about it (2026-08-13)

Nothing about the model was wrong. Three things about its _presentation_ were:

1. **Neither screen named the other.** Both now do, in one sentence each, in the page header.
2. **"No open slots" was a dead end.** It told every reader to "set their hours below", but the
   editor below is gated on `doctor:manage`, which the front desk does not hold. It now names who
   can fix it and points a walk-in at Reception.
3. **Selecting a doctor told you nothing about them.** Added _This doctor's week_ — the weekday
   hours that actually generate slots, a leave banner for the selected day, and a one-click
   **Next clinic** date. The clerk's real question is "then when?", and it now has an answer.

---

## 3. OPEN DEBT — two roster models, one of which does nothing

**This is the most confusing thing left in the module, and it is a real trap.**

There are two separate stored concepts for "when is this doctor in":

| collection           | shape                                                           | what it drives                           |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `doctorSchedules`    | weekday + `startMinute`/`endMinute`/`slotMinutes`               | **slot generation.** No row ⇒ no slots.  |
| `doctorAvailability` | weekday + sessions (`morning`/`afternoon`/`evening`/`full_day`) | **nothing computational.** Display only. |

`getAvailability()` consults `findSchedules()`, then `isOnLeave()`. It **never reads
`doctorAvailability`.**

The consequence, stated plainly: **a doctor who turns off "Wednesday" in the sessions roster still
has bookable Wednesday slots.** Only `doctorLeave` actually suppresses them. This became more
reachable on 2026-08-13, when `doctor:self-manage` gave doctors direct control of sessions and
leave — a doctor may now switch off a session and reasonably believe they have closed the clinic.

### Options, with a recommendation

- **(a) Intersect the two.** Slots = hours ∩ sessions. Correct-feeling, and it silently breaks
  every hospital that has hours but no sessions rows — they would go from a full book to zero slots
  on deploy. Would need a migration backfilling sessions from hours, and that is a data change on
  live tenants.
- **(b) Collapse to one.** Keep `doctorSchedules` as the only roster; render sessions as a derived
  view of it (09:00–13:00 _is_ "morning"). Removes the concept rather than reconciling it.
- **(c) Keep both, label them honestly.** Sessions become explicitly "what reception sees at a
  glance"; hours remain the bookable truth.

**Recommended: (b).** Two stored answers to one question will drift, and the one that drifts is
whichever the UI happens not to be showing. (a) is (b) with extra steps plus a risky migration;
(c) preserves the trap and merely documents it.

Not done here because it changes booking behaviour on live data and deserves its own change with
its own tests — not a rider on a UI fix.

### Also orphaned

`schedule:manage` is defined in the permission catalog and **used by zero routes**. Clinic hours
are gated on `doctor:manage` instead. Same family of bug as the one fixed on 2026-08-13; harmless
today, but it is a permission that reads as if it does something.

---

## 4. Where online / patient-led booking lands

The question that prompted this note was whether Appointments exists "for future online payment
from patients to book". **Partly yes — and the groundwork is already the right shape.** Nothing
below is built; this section exists so that when it is, it is not built as a fourth parallel path.

The appointment lifecycle is already `requested → confirmed → checked_in → in_consultation →
completed`, with `cancelled` / `no_show` as exits. Note that **`requested` is a real state, not a
formality** — it is precisely the state a patient-created booking should land in, awaiting the
hospital's `confirm`. The state machine was built for this before there was anything to use it.

What a patient-led booking would add, and where it attaches:

| concern                          | where it goes                               | already exists?                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patient identifies themselves    | the public site module + a patient identity | site module exists; patient auth does not                                                                                                                                                                |
| Sees free slots                  | `GET /appointments/availability`            | **yes** — but it is gated on `appointment:read`, a staff permission. A public variant would need its own narrower endpoint, deliberately: the current response reveals a doctor's whole working pattern. |
| Books                            | `POST /appointments` → `requested`          | **yes**, including `Idempotency-Key`, which is exactly what a double-tapped "Book" button on a phone needs                                                                                               |
| Pays a consultation fee up front | **not built**                               | Billing exists (`billing:create`, `payment:collect`) but is staff-initiated and post-visit. Online payment needs a gateway, a webhook, and a decision about what an unpaid booking means                 |
| Hospital confirms                | `POST /appointments/:id/confirm`            | **yes**                                                                                                                                                                                                  |
| Reminder before the day          | M4 push / SMS                               | not built                                                                                                                                                                                                |

**The one design decision to take before any of it:** does payment gate the booking, or follow it?
Recommended — **booking creates `requested` and payment confirms it.** Taking money before a slot
is held is how a patient pays for an appointment that no longer exists; holding the slot first and
letting payment (or a clerk) drive `confirm` reuses the state machine exactly as built, and an
unpaid `requested` booking expires harmlessly.

**Explicitly not a separate module.** A patient booking online must produce the same `Appointment`
row a clerk produces, in the same state machine, so that it appears on the doctor's day, checks in
into the same queue, and is counted in the same no-show report. The moment online booking gets its
own table it becomes a third intake door, and the question this document exists to answer gets
asked again.
