# MOBILE M3 — NURSE: REAL-DEVICE VERIFICATION CHECKLIST

**Status:** the nurse app is **engineering-complete on automated evidence, pending manual real-device
validation.** 1,613 mobile tests and 1,690 API integration tests green, and on 2026-08-14 the API
beneath this checklist was separately pre-validated by a server-side probe — 43 checks including two
real nurses racing one dose (see the closing section). **Nothing below marked MANUAL has been
exercised on physical hardware.**

> This is the M2 checklist's sibling and the same rule applies: **do not tick a hardware row you
> did not perform.** A row marked "not done" is more useful than one marked "assumed fine". M2's
> checklist is still unticked; it remains a prerequisite for anything auth-, lock- or
> branch-related here, and is not repeated.

Every row is marked **AUTOMATED** (a test asserts it — the row is a sanity check, not a discovery)
or **MANUAL REQUIRED** (nothing in CI can see it).

---

## 0. Before you start

> ## 🔴 STEP ZERO — converge the database, or every result below is void
>
> ```bash
> pnpm seed:demo
> pnpm seed:migrate --all          # ← the one people skip
> pnpm seed:validation
> pnpm seed:validation -- --verify # must print READY, 19/19
> ```
>
> **Migrations run inside hospital provisioning, and `seed:demo` skips provisioning for a hospital
> that already exists.** A database created before M3 therefore has no
> `one_administration_per_dose_slot` index — the constraint that stops the same dose being charted
> twice — and nothing on screen says so.
>
> This was found on 2026-08-14 on all four local tenants. A probe against that database reported two
> nurses both succeeding on one dose, duplicate second attempts, and every idempotency replay
> creating a new row. **All of it was the missing index, not a defect.** After the migration, all of
> it passed.
>
> **If §9 fails, re-run step zero and repeat before writing a defect report.** A tenant that will not
> converge invalidates every row on this page. (Risk register T2.)

|                              |                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Build**                    | `pnpm --filter @medicore/mobile start` — Expo Go is sufficient.                                                                                                                                                                                                                            |
| **API**                      | A phone cannot reach `localhost`; see `apps/mobile/README.md`.                                                                                                                                                                                                                             |
| **Accounts**                 | `nurse@sunrise.test` and `nurse2@sunrise.test` (`123456`), both hospital-wide, from `seed:demo`. Sunrise carries two active branches in different zones — Main Branch `Asia/Kolkata` and a second site `America/New_York`, 9½ hours apart, so §11 is testable in office hours.             |
| **Data**                     | `seed:validation` builds it: **45 beds, 42 admitted** (3 pages at the round's page size of 20), a severe allergy, the same drug on a scheduled AND an SOS line, a 3-line prescription so `lineIndex` identity is a position rather than "the only line", and 30 patients with nothing due. |
| **Overdue doses**            | A course runs from `signedAt`, so a prescription written at noon has no 08:00 dose to be late for. `--verify` prints the minute the first overdue appears. **Seed before 08:00 ward time** for a full day of natural due→overdue transitions.                                              |
| **Second device or browser** | Several rows need a **second nurse acting concurrently**. A second phone is ideal; the web app signed in as `nurse2@` also works.                                                                                                                                                          |

---

## 1. Login and session — MANUAL REQUIRED

- [ ] **Login** as the nurse reaches the Ward tab, not a blank tab bar. _(AUTOMATED: tab derivation from `nursing:manage`.)_
- [ ] **Cold start with a live session** restores into the app with one splash frame.
- [ ] **Logout then login as a different nurse** shows the second nurse's world — no cached rows from the first.

## 2. Branch switch — MANUAL REQUIRED

- [ ] Switch branch from the header. The ward list **repaints with the other site's patients**, never a frame of the previous site's. _(AUTOMATED: `queryClient.clear()` on branch change + key-prefix invariant.)_
- [ ] After switching, the **medication round** shows the new site's ward, and the ward picker offers that site's wards.
- [ ] Switch back. No stale row from the second site survives.

## 3. Ward selection and worklist

- [ ] **AUTOMATED** — triage order: overdue first, then due, then bed order numerically (`A-2` before `A-10`).
- [ ] **MANUAL** — pick a ward from the chips, then pick **All wards again**. This is the S5B fix; before it the bar hid itself and there was no way back.
- [ ] **MANUAL** — a 40+ bed ward scrolls smoothly and loads the next page at the bottom without a visible stall.
- [ ] **MANUAL** — pull to refresh: the rows stay on screen while it spins. The list must never blank.

## 4. Patient chart and allergies

- [ ] **AUTOMATED** — the chart opens with the visit in context (the `encounterId` param the S3 bug lost).
- [ ] **MANUAL** — a patient with a severe allergy shows it on the worklist row, the chart, and the dose confirmation screen.
- [ ] **MANUAL** — a patient with **no** allergies recorded reads "None recorded… That is not the same as no allergies", never "no allergies".

## 5. Vitals — MANUAL REQUIRED

- [ ] Enter a full set and save. The chart shows the reading with the ward's time.
- [ ] Enter an implausible value (e.g. pulse 900). It is refused, and **your typed value is still on screen**.
- [ ] Enter a second set for the same patient minutes later — both are kept. _(AUTOMATED: no uniqueness on vitals.)_
- [ ] Turn on airplane mode and try to save. The button is disabled **with a reason**, and nothing claims success.
- [ ] Save, and while it is in flight kill the network. It must not say "Saved" — it reconciles and tells you what it found.

## 6. Nursing note — MANUAL REQUIRED

- [ ] Write a note and save. It appears on the stay's timeline attributed to you.
- [ ] Start typing, then **swipe back**. The unsaved-changes prompt appears. _(AUTOMATED: the structural guard; the gesture itself is not.)_
- [ ] Save the same note twice quickly (double-tap). Exactly one note appears.

## 7. Medication round

- [ ] **AUTOMATED** — the round costs one request per page; no per-patient fan-out.
- [ ] **MANUAL** — open the round. Every row shows **name, UHID, bed, drug, dose, route and scheduled time**. This is the five-rights read; if any is missing or ambiguous on a real screen, stop and report it.
- [ ] **MANUAL** — the patient with the most overdue dose is at the top.
- [ ] **MANUAL** — a patient with nothing due says "No scheduled doses today" or "All doses answered" — never a blank row.
- [ ] **MANUAL** — the ward has more patients than one page: the footer says so rather than ending silently.
- [ ] **MANUAL, VoiceOver / TalkBack** — swipe through a dose row. It announces the patient, then the drug, dose, route, time and state. Colour alone must never carry "overdue".

## 8. Administering a dose

- [ ] **MANUAL** — tap a due dose. The confirmation names the patient FIRST, then drug, dose, route, scheduled time.
- [ ] **MANUAL — Give.** Returns to the round; that dose now reads **Given**, from the server.
- [ ] **MANUAL — Hold.** The button stays disabled until a reason is typed. _(AUTOMATED: the rule; the disabled state on a real screen is not.)_
- [ ] **MANUAL — Refused.** Records without a reason, and the reason field is offered anyway.
- [ ] **MANUAL** — reopen a dose you already gave. **No Give button at all** — facts only.

## 9. The two scenarios that matter most — MANUAL REQUIRED

These are the reason the app was built the way it was. Neither can be simulated honestly.

- [ ] **DUPLICATE.** Two nurses, two phones, same dose. Both open it; both press Give. One records; the other is told **"already given"**, by whom and when, with **no retry offered**. Neither may see a generic error.
- [ ] **LOST RESPONSE.** Press Give and kill the network **during** the request (airplane mode the instant you tap). The app must say it **could not confirm** — never "not saved". Restore the network and press again: it must resolve to "already recorded, nothing was recorded twice", not a second dose. Then check the MAR: exactly one row.

## 10. Concurrency and staleness — MANUAL REQUIRED

- [ ] Nurse A opens the round. Nurse B gives a dose. Nurse A taps that dose: S5A re-reads and shows it **already answered** — Nurse A must never see an active Give.
- [ ] Background the app for a minute while the round is open; another nurse gives a dose; resume. The round **refetches on resume** and shows the new state. _(AUTOMATED: `actionsOnResume.refetchActive`; the real AppState transition is not.)_
- [ ] Leave the round open in the foreground for five minutes without touching it. It may legitimately still show the older state — the round is advisory and the confirmation screen is authoritative. **Confirm that tapping a stale row still lands on "already answered".**

## 11. Timezone — MANUAL REQUIRED

Only meaningful with the two-timezone hospital from §0.

- [ ] Set the **phone** to a timezone hours away from the branch. Dose times still read in the **ward's** clock.
- [ ] Near the phone's midnight (but not the ward's), the round still shows the **ward's** day — it must not roll over or empty.
- [ ] Near the **ward's** midnight, the round rolls to the new clinical day.

## 12. Network and licence — MANUAL REQUIRED

- [ ] Airplane mode: reads show cached data with an offline indication; **every write button is disabled with a reason.**
- [ ] Restore the network: queries refetch on reconnect without a manual pull.
- [ ] A hospital without the nursing module: the round says **"Not in this edition"**, never an empty ward.

## 13. Performance — MANUAL REQUIRED

- [ ] A 40+ bed ward with several drugs each: scrolling stays smooth and memory does not climb across repeated navigation.
- [ ] Switch branches ten times in a row. No leak, no request storm, no stale rows.

---

## What automation already covers, so you do not have to

Ordering and triage · flag wording and screen-reader labels · empty-vs-error states · query-key
scoping (branch, ward, date, tenant) · the branch prefix on every key · allergy keys staying
hospital-wide · slot identity · duplicate protection at the database · the 409 payload and its
"do not retry" mapping · idempotency-key reach on every route that accepts one · reconciliation
classification · no local due/overdue arithmetic · no device timezone anywhere in the app · no
inline administration · no local status mutation · no raw `fetch` · no PHI in logs · pagination
totals · the round and the schedule agreeing field for field · one page costing no more queries
than one patient.

**What automation cannot cover, and why this document exists:** a rendered pixel, an OS prompt, a
real radio, a real second nurse, and a phone whose clock disagrees with the ward's.

---

## Already proven at the API, 2026-08-14 — so a failure here is a UI failure

A server-side probe drove the real API with four sessions, **two of them separate nurses racing the
same dose**. 43 checks passed on a converged database. This does **not** tick a single row above —
every one of them is about what the app _shows_ — but it does mean that **if a scenario below fails,
the fault is in the client, not the server.** That is worth knowing before you start bisecting.

| Proven at the API    | Evidence                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Two nurses, one dose | `201` + `409 HMS-MAR-001`; exactly one administration row                                                                |
| Second attempt       | `409 HMS-MAR-001` carrying `details.existing` — an answer, not a failure                                                 |
| Replay of a held key | returns the **same record id**; no duplicate                                                                             |
| Lost response        | re-read shows `given`; retry with the held key replays                                                                   |
| Round payload        | 42/42 rows carry name + UHID + bed; 18/18 doses carry drug, dose, route, time, state                                     |
| D-1 identity         | the long-stay patient is named by the server and IS outside the recent-100 window                                        |
| Vitals               | server `recordedAt`, server `flags`; pulse 900 refused; key replay no-ops; same key + different body → `409 HMS-REQ-002` |
| Permissions          | nurse writes a nursing note, is refused the doctor's ward note; doctor and receptionist both refused administration      |
| Branch isolation     | zero overlap between sites; cross-branch **writes** refused `404`                                                        |
| Timezone             | TDS lands 08:00/14:00/20:00 on **each ward's own clock**                                                                 |

**One API defect was found and is NOT fixed** — vitals reads ignore row scope, so a branch-A stay's
vitals are readable while working at branch B (risk register D1). It affects no row here; do not
report it again.
