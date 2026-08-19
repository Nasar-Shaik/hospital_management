# RISK REGISTER

Living register. Score = Likelihood (1–5) × Impact (1–5). Review monthly (Sev ≥ 12 weekly). Every risk has an owner and a mitigation that is either **built** (architecture) or **scheduled** (tracker item). Append new risks; never delete — mark Retired with date.

> **§0 is different from the rest of this file.** Everything below §0 is a risk somebody _predicted_.
> §0 is a defect somebody _found_ — confirmed present in the code, with evidence. A prediction and
> a fact do not belong in one list, and the ones in §0 were all found by running the product rather
> than by reading it.

## 0. Confirmed defects

Found by execution, reproducible. Each names the evidence so the next person does not re-investigate.

> **Reviewed in full on 2026-08-16.** Every entry was re-verified against the code before anything
> was changed, and three were not what this table said they were: **D4 and D5 describe deliberate,
> documented designs**, and **D6 was an operability defect rather than the safety defect it reads
> as**. Those corrections are below with their evidence. Reducing the count was not the goal — two
> entries stay open on purpose, and one is a product decision nobody has taken yet.

| ID  | Defect                                                                  | Sev | Status                                                                |
| --- | ----------------------------------------------------------------------- | --- | --------------------------------------------------------------------- |
| D1  | Vitals chart read ignored branch scope — cross-branch PHI               | P2  | ✅ **FIXED** 2026-08-16 (`bdc027f`)                                   |
| D2  | Reception register resolved `?date=` in `DEFAULT_TIMEZONE`              | P2  | ✅ **FIXED** 2026-08-16 (`8330faa`)                                   |
| D3  | Bed-day billing counted days in `DEFAULT_TIMEZONE`                      | P2  | ✅ **FIXED** 2026-08-16 (`1719360`)                                   |
| D4  | An unknown `X-Active-Branch` is ignored, widening the read              | P3  | 🔵 **NOT A DEFECT** — ADR-0015, see below                             |
| D5  | `maxBranches` is not derived from the plan                              | P3  | 🔵 **BY DESIGN** + one product decision                               |
| D6  | Migration 0048 over pre-existing duplicate idempotency claims           | P3  | ✅ **FIXED** 2026-08-16 (`ace9512`)                                   |
| D7  | `administeredBy` renders an identifier, not a name                      | P3  | 🟡 **OPEN** — product decision, see below                             |
| D8  | Mobile licence banner painted under the status bar                      | P3  | ✅ **FIXED** 2026-08-17 — see below                                   |
| D9  | Appointment state machine ignored branch scope — cross-branch **write** | P1  | ✅ **FIXED** 2026-08-17 (`4732dd8`)                                   |
| D10 | Report file download ignored branch scope — cross-branch PHI            | P2  | ✅ **FIXED** 2026-08-17 (`c02dd09`)                                   |
| D11 | An un-stamped report is absent from the branch-scoped list              | P3  | ✅ **CLOSED** 2026-08-17 (`0eeb882`) — same control as D12            |
| D12 | A branchless dose is absent from the chart once a branch is selected    | P3  | ✅ **CLOSED** 2026-08-17 (`0eeb882`) — window shut at branch creation |
| D13 | Mobile discarded the clinical refusal instruction ("chart on paper")    | P2  | ✅ **FIXED** 2026-08-17 (`bd09795`)                                   |
| D14 | ED triage/transfer accepted on a visit that had already ended           | P1  | ✅ **FIXED** 2026-08-19 (`9d4715b`)                                   |
| D15 | The operating surgeon is required, stored — and never displayed         | P3  | ✅ **FIXED** 2026-08-19 (`ffd481c`)                                   |
| D16 | Stock lookup 400s past a 2,000-character formulary, silently            | P2  | ✅ **FIXED** 2026-08-19 (`ac4bae9`)                                   |
| D17 | A document created by an UPSERT is never audited                        | P2  | ✅ **FIXED** 2026-08-19 — see below                                   |
| D18 | The doctor's queue renders "—" instead of a patient's name              | P2  | ✅ **FIXED** 2026-08-19 — see below                                   |
| D19 | A write is offered under "All branches" and refused only on submit      | P3  | ✅ **FIXED** 2026-08-19 — see below                                   |
| D20 | The nav advertises modules the hospital's edition does not include      | P3  | ✅ **FIXED** 2026-08-19 — see below                                   |
| D21 | An audit entry with an empty diff side could never recompute its hash   | P2  | ✅ **FIXED** 2026-08-19 — found while fixing D17                      |

> **D14–D20 were all found on 2026-08-19, in a browser, in one sitting** — the first execution of
> the Stage A validation the tracker has been asking for since 2026-08-14. Seven defects in a
> product whose automated gate was green: 2,060 integration tests, 45 Playwright specs, 0 boundary
> violations. That ratio is the finding. `TESTING.md` §11b records how it was run and what it could
> not cover.
>
> **D21 came out of fixing D17 the same day** — the first test in the project to recompute a stored
> audit hash found an entry that could never have verified. Neither defect was reachable by reading
> the code; both needed something to actually look at what the trail contained.

### D9 — the appointment state machine used the unscoped twin

Found by the security audit of 2026-08-17, and the most serious thing it found: **a cross-branch
WRITE**, which is the line §0 draws when it says the earlier defects were rated below P1 because
"none of these creates, alters or loses clinical data". This one alters it.

`appointment.repository.ts` shipped TWO reads — `findById` (bare) and `findByIdScoped`. The read
paths picked the scoped one; the state machine picked the bare one. So every transition it drives
— confirm, check-in, start, complete, no-show, cancel — resolved an appointment belonging to any
site in the hospital, while `appointment:update` and `appointment:cancel` are both declared
`"branch"` in the permission catalogue.

Measured before the fix: a Chennai clerk cancelled a Hyderabad appointment and received **200**,
and the row came back `cancelled`. The two follow-up exploits (no-show, check-in) then returned
422 — refused by the _state machine_ for being already cancelled, not by any branch boundary,
which is exactly how this could have been mistaken for working. A clerk could cancel another
site's clinic list, or mark a patient sitting in a waiting room 600km away as a no-show, with the
audit trail recording it as a legitimate action by a legitimate user.

Fixed by collapsing the two reads into one that always scopes. `scopeFilter()` returns `{}` when
there is no `ctx.scope`, so seeds, migrations and queue consumers are unaffected — the same way
`writeBranchId` reads an absent scope. Two functions where one is safe and one is not is a choice
nobody should have to make correctly every time.

### D10 — the report list stopped at the branch and the file did not

D1's sibling, missed when D1 was fixed. `emr:read` is declared `"branch"`, and
`reports.listForPatient` honours that with `scopeFilter()`. `reports.getBytes` — the same
collection, the same module, the read that returns the PDF rather than the metadata — used a bare
`findById`.

So a caller at another site could not have the report _named_ to them and could download it
anyway: the patient's name, their UHID and the result, on hospital letterhead. Rated P2 to match
D1, which is the same class (cross-branch PHI read); the payload here is larger than a vitals row,
and whether that class deserves P1 is the same open product/security question D1 left.

"Unguessable id" was never the control: a report id is an ObjectId — a timestamp, a machine id and
a counter — and every caller holding one legitimate report holds a valid sample.

Checked against **D1's own warning** rather than assumed: `reportFiles.branchId` is optional, so a
repository filter could have hidden un-stamped rows from everyone. It does not, because
`listForPatient` was already filtering — the fix made the download agree with the list rather than
drawing a new boundary, and in All mode the legacy row stays listed and downloadable. Pinned by
§25 of the branch-isolation suite as an equality between the two reads.

**A third read of the same shape was investigated and left alone.** `wallet.findEntryById` looked
identical and was not a defect: `walletAccounts` carries no branch, so a patient has one
hospital-wide advance balance and `listEntries` shows it across sites. Scoping the receipt refused
a row the same cashier could already read in the statement — D1's asymmetry inverted. It was
"fixed", then reverted (`4e724af`) once the account model was read. Recorded because the wrong fix
looked exactly like the two right ones.

### D11 — an un-stamped report is missing from the branch-scoped list

Pre-existing, and surfaced while checking D10 against D1's trap. `reportFiles.branchId` is
optional, and `listForPatient` filters on it, so a report written before branch stamping existed
is absent from the list whenever a caller has a branch selected. It remains reachable in All mode,
and the download now agrees with the list in both directions, so nothing is inconsistent — the row
is simply hidden from a narrowed view.

Left open deliberately: it is older than this audit, it loses no data, and the fix is the same
product decision D1 raised — whether an un-stamped historical row should be treated as belonging
to every branch or to none. Worth answering once, for every optional-`branchId` collection at the
same time, rather than per module.

### D12 — the branchless dose, and the window the backfill does not cover

Found by the Phase 11 integrity pass on 2026-08-17. `medicationAdministrations.branchId` is
OPTIONAL, and `mar.repository.ts` filters on it in three reads. `listAdministrations` is
`repo.listByEncounter` directly — no encounter is resolved first — so that filter is the only
boundary, and a dose carrying no branch is invisible to it.

**What normally prevents this.** `seedMainBranch` lists `medicationAdministrations` among the
collections it ADOPTS into the Main Branch, so on the ordinary rollout path a pre-branch dose is
stamped before anyone has a branch to select. §26 of the branch-isolation suite asserts that
membership rather than trusting it: if the collection ever leaves that list, the row goes red.

**The window that remains.** Adoption carries a single-branch guard — it refuses once a hospital
has two sites, because "there was only one site, so it happened there" stops being true. So a
hospital that charted doses BEFORE branches existed and created its SECOND branch BEFORE running
the backfill keeps those rows branchless. The backfill reports them rather than silently skipping
them, which is the mitigation.

**Why it is rated P3 and not higher.** The consequence is severe and specific — a dose that was
given reads as never given, and the next nurse gives it again — but it requires that exact
operational sequence, the backfill names the rows when it declines, and **there is no production
deployment yet**, so no tenant has pre-branch MAR data. Measured: the row is absent under a
selected branch and present in All mode, so it is hidden rather than orphaned.

**Deliberately NOT fixed here.** The correct fix is D1's — resolve the encounter and drop the
repository filter — but that changes a foreign visit's answer from `200 []` to `404` on the MAR
slice, which is accepted and frozen (`3089041`). Changing an accepted clinical contract for a
defect that cannot occur in any existing deployment is the wrong trade to make inside an audit.

#### D11 and D12 are the same question — answer it once

The Phase 11 pass enumerated every collection with an **optional** `branchId` whose reads
**filter** on it. That is the whole trap class, and it has exactly three live members:

| Collection                  | Read that filters               | Entry      |
| --------------------------- | ------------------------------- | ---------- |
| `reportFiles`               | `listForPatient` (+ `getBytes`) | **D11**    |
| `medicationAdministrations` | 3 reads in `mar.repository.ts`  | **D12**    |
| `wardNotes` (nursing notes) | `listForEncounter`              | same class |

All three are in `seedMainBranch`'s `BACKFILL_COLLECTIONS`, so all three are protected on the
ordinary rollout path and exposed only in the same narrow window, with the same consequence
shape: a clinical record that exists reads as absent once a branch is selected.

Three collections that already reasoned their way OUT of the class, and should stay out:
`vitals` (D1 removed the filter and resolves the encounter instead), `billing` package
enrollments (deliberately unfiltered so an event-driven charge still finds coverage), and
`patients` (identity is tenant-wide by ADR-0015).

**The product decision, taken 2026-08-17: option (b).** Should an un-stamped historical row be
treated as belonging to **every** branch, or to **none**? The answer implemented is neither — it
belongs to the ONE site that existed when it was written, and the backfill is what records that.

`createBranch` now refuses (`HMS-BRANCH-002`) while any of the three collections holds a branchless
row, so the ambiguity cannot be created. Option (a) — resolve the parent, as D1 did for vitals — is
also correct and was rejected on blast radius: it changes `200 []` to `404` on three read contracts,
one of them the accepted frozen MAR slice with two clients built against it.

Two things falsification changed about the control, both worth recording:

- It is **unconditional**, not "second branch onwards". A legacy hospital with no branches that
  creates one gets an ordinary non-main branch, and `seedMainBranch` then adds Main as its SECOND —
  backfill declines, window reopens.
- It scans **three collections, not all 35**. Scanning the whole backfill list was the first
  attempt and the branch-isolation suite proved it wrong with a single branchless `walletEntries`
  row — and migration 0047 says outright that those rows stay branchless forever by design, because
  inventing a desk for a cash deposit "would put a number in a financial ledger that nobody can
  defend". A hospital holding one would have been blocked from ever opening a second site. **A
  guard that cannot be satisfied is an outage.**

### D13 — the phone threw away the one instruction that mattered

The five clinical schema refusals exist to tell a clinician what to do when the database cannot
enforce a safety rule: chart on paper, order on paper, escalate. **None of the five was mapped in
the mobile client**, so every one fell to the generic 5xx default — "The hospital's system is not
responding. This is not something you did. Try again, and report it if it continues."

Worse, `HMS-MAR-002` was being reconciled rather than classified, so the MAR screen showed "we
could not confirm whether this dose was recorded… press again". A nurse at a bedside was told to
keep pressing a button that could not succeed for another minute, while the sentence that would
have kept the patient safe was discarded.

Not a data-safety defect — `unknown` can never render as success, never implies a dose was given,
and reconciliation recovers correctly. It is a clinical-UX defect, and the runtime-safety slice
exists precisely to deliver the sentence it was dropping.

Fixed in two halves because the clients made opposite choices about server wording: `api-client`
classifies `HMS-MAR-002` as definitely-not-written (justified by the guard being the FIRST
statement of `recordAdministration`), which alone fixes **web**, whose refusal path renders the
server message verbatim; and mobile gained real messages for all five codes, with no retry
affordance and `blocking` severity.

### D8 — the licence banner painted underneath the status bar

**Reported by a user**: the licence-expiry banner was appearing in the mobile app "at top
notifications place". They were right, and the first audit of it was wrong in a way worth recording.

**The audit's error.** This entry originally said `LicenceNotice.tsx` had zero importers and was
never mounted. That conclusion came from grepping `apps/mobile/src` and the ROOT layout
(`app/_layout.tsx`). The mount is real and one directory away, in the route-group layout
`app/(app)/_layout.tsx`, which the search never covered. **The reported observation was correct and
the repository evidence was incomplete** — the discrepancy should have been resolved by widening the
search, not by trusting the first negative.

**The actual defect.** The banner is mounted above the `<Tabs>` navigator, which puts it outside
everything that normally handles a notch: `Screen` applies insets per screen and React Navigation's
header applies its own, but both live below it. With no inset of its own the bar painted from y=0 —
under the clock and the carrier icons. That is precisely what "in the notifications place" describes.

The banner was also correct to be showing at all: `apollo` expired 2026-08-14 with 7 grace days, so
on 2026-08-17 it is in `GRACE` with four days left, and `harmony` expires 2026-08-24 (`EXPIRING`).

**The fix**, in two halves, because exactly one component may own the inset:

- `LicenceNotice` pads itself by `insets.top` — padding rather than a wrapping `SafeAreaView`, so
  the tinted surface extends up behind the status bar instead of leaving a mismatched strip above it.
- The group layout hands the navigator a `SafeAreaInsetsContext` with `top: 0` **while the banner is
  showing**, because React Navigation reads that context and would otherwise pad its header by the
  same amount again, leaving a status-bar-sized gap. A healthy licence passes the insets through
  untouched. Both halves read one shared hook, so they cannot disagree about whether the bar is up.

Licence semantics are unchanged: `blocksWrites`, `licenceNotice` and the ACTIVE/EXPIRING/GRACE/
EXPIRED policy are all exactly as they were.

**Why no test caught it.** `licence.test.ts` §4 proved the POLICY in five ways — tone, day counts,
singular/plural, silence when ACTIVE — and every one of them would have passed with the component
deleted. `routes.test.ts` only asserted the file was ALLOWED to know about the licence. Together
they looked like coverage of a feature while covering only its policy. §6 now asserts reachability
and the inset agreement, and each assertion was falsified by removing the thing it checks.

### D1 — what it was, and why the obvious fix was the wrong one

`recordVitals` resolved the encounter through `getEncounter` (branch-scoped) before writing, so a
foreign visit refused the WRITE with a 404. `listForEncounter` went straight to the repository. You
could therefore **read a chart you could neither open nor write to** — asymmetry, not a missing
filter. Probed 2026-08-14: HTTP 200 with rows at the other branch, while the same stay's schedule,
administrations and notes correctly returned nothing.

Fixed by resolving the encounter in the read, exactly as the write does. **Not** by adding
`scopeFilter()` to the repository, which is the obvious fix and is wrong: `vitals.branchId` is
optional and denormalised, so filtering on it hides any reading charted before that stamping
existed — from everyone, including the nurse who took it. A falsification test proves this rather
than asserting it: with the repository filter applied, all seven scope tests pass and only the
un-stamped-row test goes red.

The patient TREND read stays hospital-wide, which was always deliberate (the same exception
allergies take) but was documented for one read while three were unscoped. It is now named
`forPatientAcrossBranches` and pinned by a test.

**The branch-confined case is now proven, not inferred.** It was the open question in this defect's
severity assessment and the answer is yes — a bound user was affected too.

### D4 — the header is IGNORED, and that is ADR-0015's choice

A caller who sends an `X-Active-Branch` they may not use is **not refused**; the header is dropped
and the request falls back to the caller's own allowed scope. ADR-0015 chose this deliberately —
"a stale selection fails SAFE (to the caller's own scope) instead of leaking or 500-ing" — and
`branchIsolation.int.test.ts` pins it, with a header comment stating that the suite deliberately
does **not** assert a 4xx because that would test a design the project did not choose.

It cannot exceed the caller's binding: a confined user stays confined. What a hospital-wide caller
gets is their full scope, which is wider than the single site the stale header names — so a client
can show one site's name over aggregate data. That is a real UX wart and it is **a product
decision about client feedback**, not a scope defect. Reclassified; no code change.

### D5 — the edition's `maxBranches` is a catalogue figure, on purpose

`tenant.service.ts` says it outright: "An edition's `limits.maxBranches` is a catalogue figure that
is never applied to a tenant", and `subscription.service.ts` repeats it — "reading the edition's
catalogue figure here would print a number the API does not honour, in either direction." The cap
is a per-tenant PLATFORM control an operator sets, so that the wall and the meter read one
function. That is coherent and it is not a defect.

**What is genuinely unresolved is narrower**: `provisionTenant` has the plan code in hand and
stamps no cap, so every new hospital defaults to 1 site whatever tier was sold, and the operator
must know to call `setLimits` separately. Both `seedDemo` and `seedValidation` carry workarounds
for exactly this.

**PRODUCT DECISION REQUIRED — not taken here.** Whether buying a 3-site plan should grant 3 sites
automatically, or whether site count stays a deliberate per-hospital provisioning choice, is
commercial policy. The code implements the second, with reasons written down. Changing it
unilaterally would be an engineer deciding what the company sells.

### D6 — the runner was already safe; the message was not

`idempotencyKeys` has existed since 0004 with a TTL and no uniqueness, and the `idempotent()`
middleware writes to it, so a tenant that served traffic before 0048 landed can hold two rows with
the same identity and the unique index cannot build. Observed on `hms_sunrise`, 2026-08-14.

Re-verified: **the runner records a migration only after `up` resolves**, so a failed 0048 leaves
no record and the tenant is not falsely converged. There is a test asserting this and it passed
before the fix. This was an operability defect, not a safety one — the answer was
`Index build failed: <uuid>` on a tenant that had silently stopped.

0048 now preflights, names the collision count, says what those rows are (a 24-hour replay cache),
and gives two deterministic remedies. It **refuses rather than pruning**: deleting rows to make a
migration pass is destructive (Constitution §3.9), and duplicate claims mean something already
went wrong.

### D7 — the record is complete; the display is degraded

`administeredBy` is an opaque user id. The user directory needs `user:manage`, which NURSE
correctly does not hold, so the client cannot resolve a name and says the one thing that changes
behaviour: "by you" (your own lost attempt) or "by another member of staff" (go and ask).

**Clinical accountability is intact** — the id is authoritative, stored on the MAR and audited.
What is missing is the name at the point of a duplicate, which makes "go and ask them" harder.

**Left open deliberately.** The correct fix is server-side DTO expansion, the way invoice
signatories are already expanded — never a user-lookup path in the browser. That is a small
feature, not a defect fix, and expanding a DTO for UI convenience is explicitly not something to
do on the way past.

**Rated below P1 deliberately — D1 through D8.** None of _those_ creates, alters or loses clinical
data. D1 was the most serious because cross-branch PHI is the class multi-branch Phase 0 existed to
eliminate; it is now closed, and whether it should have been rated P1 rather than P2 remains a
product/security question that the fix does not retroactively answer.

> **Superseded in part on 2026-08-17.** The sentence above was written when every confirmed defect
> was a read. **D9 is a cross-branch WRITE** — a clerk at one site cancelling another site's
> appointment — so it crosses the exact line this paragraph draws and is rated P1 on the register's
> own terms. The paragraph is kept rather than rewritten because the reasoning it records is still
> the right test; D9 is the first entry to fail it.

### D14 — an emergency visit that had ended still accepted both writes

The most serious thing this validation found, and P1 rather than P2 for the same reason D9 is: it
**alters clinical data**.

`requireEdEncounter` refused a visit of the wrong class and stopped there. Nothing required the
visit to still be OPEN. Measured live against the running stack:

- A patient already **transferred out to another hospital** accepted a fresh triage — HTTP **201**
  — and their `triagedAt` was rewritten. An assessment filed, with a timestamp, on somebody who
  was not in the building.
- Worse: `transferOut` writes the transfer record **before** `closeEncounter` validates the state
  change. A second transfer on the same visit was refused with a 422 from the state machine — but
  only after the write had landed. A real destination, `"Apollo Hospitals, Jubilee Hills — Cath
Lab"`, became the second caller's text. **A call that reported failure destroyed a clinical
  fact.**

Fixed with one guard: an ED write requires an open visit. That closes the second defect properly
rather than by reordering, because a closed visit is refused before anything is written at all.

The regression test asserts the stored destination **before** the status, deliberately: the broken
version refused the second transfer too, so a test that checks the status first fails on the status
and never reaches the damage.

### D17 — a document created by an upsert has no audit trail

Platform-level, in `core/db/plugins/auditPlugin.ts`. The post-`findOneAndUpdate` hook reads:

```ts
if (!before) return; // upsert of a brand-new doc, or nothing matched
```

So **any document whose first write is an upsert is never audited.** Emergency surfaced it because
it is the first module whose primary write is an upsert: the first triage of a patient produced no
audit row at all, and only the _re-triage_ appeared, as `edTriage.updated`. `EMERGENCY.md` states
that the audit log **is** the re-triage history — with this gap the original assessment is not in
it, and in the common case (triaged once, never revised) there is no trail of the clinical decision
at all.

**FIXED 2026-08-19.** The early return was protecting a real case and could not simply be deleted:
a `findOneAndUpdate` that matches nothing and does not upsert changed nothing, and an entry for it
would be a fabricated event. The two cases are now told apart by what the DRIVER reports, measured
rather than assumed (Mongoose 8.13 / Mongo 7):

| call                             | inserted                       | matched nothing |
| -------------------------------- | ------------------------------ | --------------- |
| `findOneAndUpdate` + `new: true` | the document                   | `null`          |
| `findOneAndUpdate`, no `new`     | **`null`** — same as no-op     | `null`          |
| `updateOne` + `upsert`           | UpdateResult with `upsertedId` | all-zero result |
| a write that throws              | post hook does not run at all  | —               |

So the create path keys its read on the id the driver reported. A re-read on the FILTER would have
covered the second row of that table too, and is exactly what this must not do: under a concurrent
insert it would attribute another caller's document to this one. The second row is closed at the
call sites instead — an audited upsert must ask for the new document, which was true everywhere
except `wallet.repointPatient` (a wallet account created by a patient merge, in a `financial`
collection, absent from the financial trail). `auditedUpsertsReturnTheNewDocument.test.ts` fails
the build if a new call site drops it.

**The vocabulary did not need extending.** `verbFor` has always answered `created` for an absent
pre-image — the `save()` path has used it since the beginning. The query path simply never reached
it. No new event type was added.

**What made this survivable for so long:** `auditPlugin` had **no test of any kind**. Route
permissions were covered, the export's content type was covered, the page loaded in Playwright —
nothing asserted the trail's contents. `auditPlugin.int.test.ts` is now that suite.

### D21 — an audit entry whose diff had an empty side could never verify

Found while writing the D17 tests, by the first assertion in the project that recomputed a stored
audit hash.

`diff` records a previous value only where one existed, so an update that merely ADDS fields — a
transfer-out putting `transferredTo` on a triage row that never had one — produces `before: {}`.
Mongoose's default `minimize` strips empty objects on the way to the database, but the leaf hash had
already been computed over the entry as BUILT. The stored entry could therefore never recompute to
its own hash, and `verifyAuditChain` would report **content-tampered on an entry nobody touched** —
turning the tamper alarm into noise, which is the one failure mode a tamper-evident log cannot
afford.

One entry in 202 in the new suite's fixture hit it. Fixed at both ends, because either alone leaves
a sharp edge: `audit.model.ts` sets `minimize: false` so storage cannot alter what was hashed, and
the plugin no longer writes an empty side at all — absence says "none of the changed fields had a
previous value", which is what actually happened and how a CREATE already reads.

### D18 — the doctor's queue shows a dash where a name belongs

`/my-patients` loads the queue with `listEncounters({ queued: true, limit: 100 })` and, separately,
`listPatients({ limit: 100 })`, then joins them in the browser:

```ts
const nameOf = (id: string): string => patients.find((p) => p.id === id)?.name ?? "—";
```

Two independently capped lists and one join between them. Any queued patient outside that page of
100 has no name. Observed on the demo hospital: **15 of 99 rows** in the doctor's own worklist
rendered as "—", with no error and no empty state — just a dash where a person should be.

The fix is a decision rather than a patch: resolve the names the queue actually needs, by id,
instead of hoping they fall inside an unrelated page.

**Fixed 2026-08-19 — server-side, once, for every list.** `GET /encounters` now returns
`EncounterRow` (the encounter plus `patientName` and `uhid`), resolved by the same `namesByIds`
call `/inpatients`, `/bed-board` and `/medication-round` already make: one `$in` per page, not one
query per row. Three clients stopped guessing — `/my-patients` and `/reception` deleted their
`patients.find(...) ?? "—"` joins, and the phone deleted a per-row `getPatient` fetch that
`Identity.tsx` had already documented as "the one place an API change would pay for itself".
`/my-patients` now issues one request fewer than before the fix.

**Why the same defect happened twice.** The identical join was found and fixed on the WARD in July,
and the reasoning written into `encounter.contract.ts` at the time — "an encounter is a visit;
naming the patient on every one of them would cost a lookup on paths that never display a name" —
was true and drew the line in the wrong place. The line is not `/inpatients` versus the rest, it is
a LIST (a screen somebody reads) versus a single encounter. `GET /encounters/:id` still carries no
identity, and that is still correct.

**The other half of the same cap, found while repeating the browser suite.** The list itself asks
for one page of 100 and truncated in silence — the tail of the waiting room simply absent. It
surfaced as a browser failure: an E2E patient standing at position 104 in a queue of 107 could not
be found on the page while being genuinely in the queue. The page now says how many are beyond it.
Deliberately not a bigger limit: the rows are in TOKEN order, so the hundred shown are the hundred
who arrived first, which is the right hundred — what was missing was the sentence admitting there
are more (D-2 below explains why the queue was 107 at all).

Proved by `encounters.int.test.ts` §8, whose fixture buries the queued patient under 120 later
registrations so that any implementation resolving identity from a page of recent patients gives
the wrong answer, and by `queueIdentity.test.tsx`, which mounts both real web pages against a
server whose `/patients` returns a hundred other people. Falsified both ways: removing the
server-side join turns 8 integration tests red, and restoring the capped join — on the client or,
compiling cleanly, on the server — turns the load-bearing ones red while the small-hospital case
still passes, which is exactly why nobody noticed for a milestone.

### D-2 — a browser spec grew the hospital it asserts against, one patient per run

Not a product defect: a TEST defect, recorded here because it was mistaken for one and because its
failure mode is worth knowing. `pharmacyDispensing.spec.ts` opens a visit for its own patient and
must leave it OPEN while it runs — a closed encounter drops out of the doctor's queue, and the
pharmacy half needs the prescription dispensable. Its teardown cancelled the prescription and never
closed the visit.

So every run of the browser suite added one patient to Dr Rao's queue, permanently. By the time it
was noticed there were **57 of them** and the queue held 107 — past the page `/my-patients` asks
for — and `emergencyWorkflow` began failing while looking for a patient who was really there, two
rows past the end of the page.

Two fixes, and they are different in kind. The spec now closes its visit (`afterAll`), so the
suite leaves the waiting room the size it found it: measured at 52 queued before three consecutive
runs and 52 after. And the PRODUCT now says when a queue is longer than the page — because "the
tail is missing and nothing says so" is the same defect as D18 wearing a different hat, and the
only reason it was found is that a test happened to stand in the truncated part.

The 57 leaked visits were closed in the local dev hospital to make the suite deterministic again;
two refused (they are `awaiting_results`, which `close` does not accept) and were left alone.

### D19 — the branch a write needs is chosen after the work, not before

Met twice in one session, on two actions and two roles. With the header on **"All branches"** the
emergency board loads, rows render, and every action is enabled. The nurse picks a priority, types
a chief complaint, presses Save — and only then gets `HMS-BRANCH-001 No active branch selected`.
Switching the branch to fix it **closes the modal and discards what she typed.**

Not specific to Emergency: the same refusal stopped a theatre booking during the Theatre milestone,
where it was worked around in the Playwright fixture with `switchToBranch()` rather than fixed in
the product. A test can be taught to set the branch first. A person cannot be, because nothing on
the screen tells them.

**Fixed 2026-08-19 — the question is asked before the work, not after it.**
`mustChooseBranchToWrite()` in `lib/branchScope.ts` restates the server's rule rather than
inventing a second one: refuse only when the caller can reach SEVERAL active sites and has chosen
none, which is exactly `writeBranchId()`'s condition over exactly the list `GET /me/branches`
returns. `BranchProvider` publishes it; the four write actions that stamp a branch (ED triage, ED
transfer-out, theatre booking, new theatre) are disabled while it holds, and
`<ChooseBranchNotice>` explains why and lists the sites inline — because sending somebody to a
control in the top-right corner is how the switcher got missed in the first place.

Two things deliberately NOT done. The guard is on the way IN, not inside the form: choosing a
branch re-keys the routed subtree and discards the screen, which is correct and is precisely what
must not happen over a half-typed modal. And "Send to doctor" is left enabled — it is a transition
on a visit that already has a branch, it succeeds in aggregate mode, and disabling it would strand
a triaged patient on the board.

The server rule is unchanged and is now pinned independently (`emergency.int.test.ts`,
`theatres.int.test.ts`): a hospital-wide caller with no site gets `HMS-BRANCH-001` on all four
writes, a forged branch header is ignored rather than obeyed, and a single-site nurse is never
asked to choose. Falsified in both directions — deleting the UI predicate turns 5 jsdom tests and
2 Playwright tests red; making the server guess the first candidate instead of refusing turns 5
integration tests red across two modules.

### D20 — the sidebar sells what the edition does not include

A `PLAN_CLINIC` tenant's navigation offers Theatres, Emergency, Ward, Bed board, Medication round,
Ambulance, Mortuary, Pharmacy and more. The nav gates on **permission** and never on
**entitlement**, so an administrator holds the codes and sees every door.

The API is correct — `HMS-PLAN-002 Feature not in your edition`, naming the exact flag. The page
then puts the refusal and a contradiction side by side: `/emergency` shows "Feature not in your
edition" and, directly below it, **"Nobody in the emergency department."**; `/theatres` offers
"Book a procedure" and "Add theatre" and reports "No theatres yet."

Same "a refusal shown as emptiness" class `TESTING.md` §11 recorded from the page sweep, on pages
written after that sweep — which suggests the lesson needs to live in a shared component rather
than in the memory of whoever fixed it last time.

**Fixed 2026-08-19 — both halves, and neither is a plan check.** The nav could not gate on
entitlement because no client could ask: `GET /subscription` needs `subscription:manage`, which no
clinician holds, and the mobile app had been reduced to learning the hospital's edition by asking
for a module and reading `HMS-PLAN-002` back. `/auth/me` now carries `features` beside
`permissions` — ADR-0010's first two layers in the one call every client already makes — and
`NAVIGATION` items carry a `FeatureFlag` (typed, so a flag that does not exist does not compile).
Thirteen entries are tagged. `hasFeature` fails OPEN while the edition is unknown, on purpose: a
false negative hides a module a hospital pays for and nobody reports a menu entry they have never
seen, while a false positive costs one honest refusal.

The second half is the contradiction on the page. `isFeatureUnavailable()` — the same predicate,
under the same name, that `apps/mobile/src/lib/net/errors.ts` has had since M0 — now lets
`/emergency` and `/theatres` render `<ModuleNotInEdition>` INSTEAD of their board, their empty
state and their write buttons, and say in as many words that no permission change will open it.

Server enforcement is untouched and is what a typed URL still meets. `navigationEntitlement.test.tsx`
drives the real `AppShell` against the real `EDITIONS` data and checks each entry against its OWN
flag — withdrawing one flag from a full edition must hide exactly the entries that depend on it,
which is what catches an entry tagged with a wrong-but-valid flag. Falsified: removing the
entitlement gate from the nav turns 13 tests red, removing layer 1 from `authorize()` turns the
direct-route tests red, and making `isFeatureUnavailable` always false brings the refusal-beside-
emptiness back on both pages.

**Not covered by Playwright, and deliberately.** There is no `PLAN_CLINIC` tenant in the seeded
hospital, and the only way to make one in a browser run is an operator-token feature override — a
test that, if it died halfway, would leave the shared seeded hospital missing a module and poison
every other spec. The nav is proved in jsdom against real edition data and the refusals are proved
over real HTTP; the browser investment went to D19 instead, where the starting state (an
administrator landing in "All branches") is a property of the running application that jsdom
cannot stage.

## Technical

| ID  | Risk                                                               | L×I    | Mitigation                                                                                       | Status                                     |
| --- | ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| T1  | Cross-tenant data exposure via mis-resolved connection or bug      | 2×5=10 | DB-per-tenant + host↔JWT match + tenantId stamping + isolation test suite on every route (CI)    | Built into design                          |
| T2  | Fleet migration failure leaves tenant DBs on mixed schema versions | 3×4=12 | Per-tenant migration tracking + convergence metric + expand/contract policy + resume-safe runner | 🔴 **MATERIALISED 2026-08-14 — see below** |
| T3  | Connection-pool exhaustion at tenant-count growth                  | 3×3=9  | LRU caps + metrics + load-test validation (PROJECT_MEMORY assumption A3)                         | Scheduled P9                               |
| T4  | Modular monolith decays into big-ball-of-mud                       | 3×4=12 | CI boundary enforcement (dep-cruiser) + review rules; never disable the lint                     | Built into CI from P0                      |
| T5  | Read-model drift vs OLTP truth                                     | 3×3=9  | Rebuildable projections + freshness metric + weekly reconciliation job                           | Design (Doc 03 §9)                         |
| T6  | Double-charging / duplicate financial postings under retries       | 2×5=10 | Idempotency keys + counters + `payment: pending_reconciliation` + financial test suite           | Built into design                          |
| T7  | Master DB becomes a single point of failure                        | 2×4=8  | Cache-first reads + TTL-extension emergency flag + hourly snapshots (DR §2c)                     | Designed                                   |

### 🔴 T2 materialised — 2026-08-14

**This register predicted it in July and the mitigation was never built.** On 2026-08-14 **all four**
local tenant databases were found two migrations behind: `0048-idempotency-key-claims` and
`0049-one-administration-per-dose-slot` had never been applied. `hms_sunrise` had 47 migrations and
**no unique index on `medicationAdministrations`**.

**Why it happened:** migrations run inside `provisionTenant`, and `seed:demo` skips provisioning for a
tenant that already exists. Nothing else converges a tenant on the current schema, and nothing warns.

**What it cost, concretely.** A safety probe run against that database reported seven catastrophic
failures — two nurses both charting the same dose, second attempts creating duplicates, every
idempotency replay creating a new row. **Every one was the absence of the safety mechanism, not a
defect in it.** After `pnpm seed:migrate --all`, all seven passed. A human working the M3 checklist
would have raised duplicate administration as a P0 and been wrong.

**Partially controlled, 2026-08-16.** `seed:validation` (both the seeding run and `--verify`) now
refuses to touch a tenant that cannot enforce the clinical invariants, checking the canonical
`pendingCount()` **and** the actual indexes — because a migration record is weaker evidence than the
constraint, and a dropped index leaves the record behind. Proven by falsification: disabling the
index inspection turns four controls red. **This gates ONE tenant at validation time and is not the
metric T2 asks for**; it cannot see the fleet and must not be described as if it could.

It also exposed a sharp edge worth knowing: when a constraint is gone but its record remains,
`pnpm seed:migrate` **skips the migration and prints "tenant converged" while changing nothing**
(measured: `migrationsApplied: []`, index still absent). The block message now gives that case its
own remedy — clear the record, then converge — because the obvious instruction is wrong for it.

**A fleet answer now exists, 2026-08-16 (`fe6f6e7`).** `pnpm seed:migrate --check` walks every
tenant, runs the per-tenant verdict (canonical `pendingCount` **and** whether the clinical
invariants are actually armed), names any tenant that is behind and the rule that died, and exits
non-zero so a deploy step or a cron can read it. It writes nothing — asking must never change the
answer. Proven against the real fleet: 4/4 and exit 0; index dropped on one tenant → `NOT
CONVERGED` naming it and exit 1; remediation followed → green.

It separates the two failure modes, because the obvious remedy is wrong for one: a tenant whose
migration is RECORDED but whose constraint is gone is **skipped** by `migrate --all`, which then
reports success while changing nothing. Those are listed as `drifted` and told to clear the record
first.

**Made deployable, 2026-08-16.** `--check` is now a release gate with a stable exit contract —
`0` READY, `1` NOT_READY, `2` ERROR — and `--json` for a deploy step. The full command, the seven
failure categories and the remedy for each live in **[DEPLOYMENT_GATE.md](./DEPLOYMENT_GATE.md)**;
they are not repeated here. Four things it can now answer that it could not before, each of which
had been reporting as something else:

- **"Could not look" is no longer "the schema is wrong."** An unreachable tenant used to exit `1`
  alongside a tenant that was genuinely behind, and the printed advice for both was "run
  `migrate --all`" — an instruction to migrate a database nobody can reach.
- **A history that cannot have happened** — a renumbered id, or an outstanding migration sitting
  beneath one already recorded — used to read as ordinary lag. Converging it is actively unsafe.
- **A tenant on a NEWER schema** was invisible: measured, a database holding every known id plus
  one unknown returned `ok: true` silently. It is now reported, and deliberately still READY —
  expand→migrate→contract makes it servable, and failing it would block every rollback.
- **A registry row with no `databaseName`** used to be coerced to the string `"undefined"`, and
  mongoose opens a real database of that name. The check reported a live hospital as drifted, and
  `migrate --all` would have created the junk database and run 49 migrations into it. Both paths
  now refuse the row instead of inventing one.

**T2 still stays open.** All of the above is still a command somebody runs, not a gauge that
watches.

**Two corrections to this entry's own history.** The predicted mitigation was the metric
`hms_migration_pending{tenant}`; that metric is listed in OBSERVABILITY_GUIDE alongside ~20 others
and **none of them exist** — there is no `prom-client`, no `/metrics` endpoint and no registry in
this API. And a comment on `pendingCount` claimed it fed that metric, which was false. Building a
Prometheus surface for one gauge would mean standing up the whole observability layer as a side
effect of a defect fix; that layer is scheduled work (P9) and **owns this problem**.

**T2 STAYS OPEN.** A gauge scraped every minute tells you at 03:00 that a tenant drifted; a command
tells you when someone runs it. What is closed is the specific failure that happened — a stale
tenant discovered through a clinical failure. Until the observability layer exists:

- `pnpm seed:migrate --check` answers convergence on demand; `--all` fixes it.
- `pnpm seed:migrate --all` is a **precondition of any validation run** (stated in both device
  checklists, the manual validation runbook and `SEED.md`).
- A tenant that fails to converge must be treated as invalidating every result taken against it.

**Do not treat this as closed by the manual step.** The step is a workaround for a missing control,
and the register scored this 12 for a reason.

## Business

| ID  | Risk                                                                    | L×I    | Mitigation                                                                                        | Status                                  |
| --- | ----------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| B1  | Editions mispriced → small clinics unprofitable / hospitals underserved | 3×4=12 | Usage metering from day 1; pricing placeholders reviewed with design partners before GA           | Open — owner input (PROJECT_MEMORY §10) |
| B2  | 25-org-type promise creates unbounded specialty scope                   | 4×3=12 | Flag-gated specialty wave is post-hospital-core; edition demand pulls modules, not sales promises | Governance (Doc 05)                     |
| B3  | Incumbent lock-in (data migration fear) blocks sales                    | 4×3=12 | Import tooling (P9) + migration playbooks as first-class product                                  | Scheduled                               |
| B4  | Design partners shape product toward one hospital's quirks              | 3×3=9  | Config-first rule (Constitution §2.3): partner needs become flags/config, never hardcode          | Standing rule                           |

## Operational

| ID  | Risk                                                         | L×I    | Mitigation                                                                           | Status                                  |
| --- | ------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------ | --------------------------------------- |
| O1  | On-call gaps in small team during incidents                  | 3×4=12 | Runbooks (DR), auto-remediation-first alerts, managed services (Atlas)               | Partially designed                      |
| O2  | Hospital go-lives fail on data quality (bad masters/imports) | 4×4=16 | Import validation tooling + golden master templates + go-live checklist w/ sign-offs | Scheduled P9 — **top operational risk** |
| O3  | Support can't distinguish tenant-specific vs platform issues | 3×3=9  | Tenant drill-down dashboard + traceId in every error                                 | Designed                                |
| O4  | Untested backups                                             | 2×5=10 | Daily rotating restore-verification (DR §Backup)                                     | Designed                                |

## Security

| ID  | Risk                                    | L×I    | Mitigation                                                                           | Status                    |
| --- | --------------------------------------- | ------ | ------------------------------------------------------------------------------------ | ------------------------- |
| S1  | PHI breach (external attack)            | 2×5=10 | Field-level encryption, WAF, pen-tests, scanning pipeline, least-privilege infra     | Scheduled P9 + continuous |
| S2  | Insider misuse (staff browsing records) | 3×4=12 | Access-event auditing + anomaly reports (accounting of disclosures)                  | Designed (Doc 09 §9)      |
| S3  | Compromised tenant admin account        | 3×4=12 | MFA enforcement for privileged roles, session anomaly detection, impersonation audit | Designed                  |
| S4  | Supply-chain (dependency) compromise    | 2×4=8  | Lockfiles, scanning, SBOM, minimal-dependency rule (Constitution §6)                 | Built into CI             |

## AI-Specific

| ID  | Risk                                                                | L×I    | Mitigation                                                                                                                            | Status                           |
| --- | ------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| A1  | AI agent introduces duplicate/divergent implementations over months | 4×3=12 | Guidelines §3 search-before-create + review checklist + this governance layer                                                         | **This layer is the mitigation** |
| A2  | AI-generated code silently weakens a safety/financial check         | 2×5=10 | Never-rule 11 + mandatory suites can't be edited in the same PR as features touching them (review rule)                               | Standing rule                    |
| A3  | Clinical AI feature harms a patient (wrong suggestion accepted)     | 2×5=10 | Advisory-only + licensed-user sign-off + guardrail audits (Doc 01 P8); no autonomous clinical action ever (PROJECT_MEMORY assumption) | Constitutional                   |
| A4  | PHI leaked into third-party model prompts                           | 2×5=10 | Redaction layer before provider calls + DPA-gated provider config + prompt audit log                                                  | Designed (Doc 02 J1)             |
| A5  | Doc/code drift makes AI agents confidently wrong                    | 4×3=12 | Doc-update matrix (Guidelines §4) + PR checklist + drift = defect culture                                                             | Standing rule                    |

---

## P2 REVIEW BEFORE PILOT — 2026-08-17

Every remaining P2 and the open P3s, asked the same five questions: is it a genuine **engineering**
issue, a **product** decision, an **operational** one, an acceptable **pilot limitation**, or
**V1.1**? Nothing here was fixed as a result. The bar for acting was deliberately narrow — _does it
block **safe** pilot operation_ — and none of them clears it.

| Item                                                       | Kind        | Verdict for the pilot                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VPS P2-1** no reverse-proxy config committed             | Operational | Folds into **P1-1**. Wildcard TLS and host routing are the same afternoon's work; doing them without committing the config is what makes the second deploy a rediscovery. Not separately blocking.                                                                                                                                                                                                               |
| **VPS P2-2** no log rotation                               | Operational | **The closest to a real one.** Docker's json-file driver grows unbounded, and on a single VPS a full disk takes MongoDB with it — a data-availability failure with a clinical consequence, reached by doing nothing. Two lines of daemon config; **do it with P1-2**, not as its own project.                                                                                                                    |
| **VPS P2-3** backup is manual                              | Operational | Accepted **only** with the honesty already written into DR §0.5: RPO is the age of the last dump. A cron and an off-site copy are in MUST-BEFORE-PILOT because a pilot hospital's data is real, not because the procedure is wrong.                                                                                                                                                                              |
| **VPS P2-4 / T2** observability is documentation, not code | Engineering | **V1.1.** `seed:migrate --check` answers the fleet question on demand and exits with real codes; what is missing is a gauge that answers it at 03:00 unasked. A pilot of one or two hospitals is small enough to ask. T2 **stays open** and stays honest.                                                                                                                                                        |
| **D7** `administeredBy` shows an id, not a name            | Product     | **Not a defect to fix now.** Accountability is intact — the id is authoritative, stored and audited. The fix is server-side DTO expansion, which is a small **feature**, and the client already says the one thing that changes behaviour ("by you" vs "by another member of staff"). Before general release.                                                                                                    |
| **D4** unknown `X-Active-Branch` widens the read           | By design   | Re-confirmed as ADR-0015 behaviour, not a defect. Stays as **BR-09**: record, do not re-report.                                                                                                                                                                                                                                                                                                                  |
| **D5** `maxBranches` not derived from the plan             | Product     | One decision for whoever owns pricing. No engineering work pending on it.                                                                                                                                                                                                                                                                                                                                        |
| **9 `candidate: true` unique indexes**                     | Engineering | Each is "should this get a runtime 503 guard too?". **None qualifies for V1**, and the reason is written next to each: every one of them fails _visibly_ — a duplicate invoice on the register, a theatre clash on a list a human reads before anyone is wheeled in. The clinical five fail _silently_, which is why they are guarded and these are not. `charges.one_charge_per_cause` is the first to revisit. |
| **`orders.findByRequestId`** unscoped                      | Engineering | P3. Reachable only with a UUID the caller already generated; no enumeration path. Recorded, not fixed.                                                                                                                                                                                                                                                                                                           |
| **`mar.administeredBy`** optional at the model             | Engineering | P3. The service always sets it; the model permits absence. Tightening it is a migration for a case that has never occurred. Before general release.                                                                                                                                                                                                                                                              |

**Conclusion: no P2 blocks safe pilot operation.** Two (P2-2 log rotation, P2-3 backup automation)
are operational work that should ride along with the P1 environment items rather than be scheduled
separately — and P2-2 is the one that fails without anybody touching it.

### T3 — the only gate is not deterministic (raised 2026-08-17, CLOSED 2026-08-17)

| ID  | Risk                                                                       | L×I   | Status                                      |
| --- | -------------------------------------------------------------------------- | ----- | ------------------------------------------- |
| T3  | The single quality gate fails intermittently, so "green" is not repeatable | 3×3=9 | 🟢 **CLOSED** — root cause proven and fixed |

CI is billing-locked and the accepted V1 position is that `pnpm gate` on one machine **is** the
gate. That position rests on the gate being trustworthy. Across eight full runs on 2026-08-17, six
failed 1–4 tests each and two were green — every failure a timeout, 404 or 401, never a wrong
clinical, billing or permission answer, and no test failing twice.

**Root cause: the failing requests were answered by a different process on this machine.**
`request(app)` opens **one HTTP server per request** (supertest calls `app.listen(0)` each time), so
a full run burns ~8,200 of the 16,384 ephemeral ports macOS offers. `listen(0)` binds the
**wildcard** address and Node sets `SO_REUSEADDR`, so that bind **succeeds** on a port another
process already holds on `127.0.0.1` — silently. supertest then connects to `127.0.0.1:<port>`, and
the kernel gives the connection to the most specific listener: the other process. Five such
listeners were live on the machine (four editor helpers and a JVM), and **every anomaly across three
instrumented runs landed on one of those five ports**. Some of those helpers are themselves Express,
so the reply was a genuine Express 404 for a route they had never heard of; the JVM reset the
connection instead, giving "socket hang up".

**Fixed** by hoisting one loopback-bound server per suite (`listening()` in
`apps/api/src/test/appServer.ts`): the kernel will not hand a `127.0.0.1:0` bind a port already in
LISTEN on that address, so the collision is impossible rather than rare, and the ~4,100 binds per
run become 21. `noWildcardBinds.setup.ts` makes the old default throw, and
`src/testServerBinding.test.ts` pins both the guard and the platform behaviour it defends against.
Verified with a full `pnpm gate` green end to end — integration **1842/1842** — while the five
foreign listeners were still up.

**The evidence that broke it open was an absence.** `requestLog` sits second in the chain so that
every request is logged on `finish`, and the failing requests had **no log line at all**. That was
read for days as a logging problem. It was the literal truth: the request never arrived. Tracing
below Express at `node:http`, to a file rather than through vitest's stdout capture, showed the
responses arriving with **no `x-request-id`** — and since `requestId` is the first middleware, that
alone proves they did not come from this application. `lsof` at the moment of the anomaly named the
process that had answered.

**Two wrong answers were published before the right one, and both are kept on the record**
in [`TESTING.md`](../../TESTING.md) §9. The first blamed contention from other projects' containers
on the strength of one green run after a Docker restart, and was retracted when the next gate failed
with the host unchanged. The second was our own claim that every failure was a timeout; run B's was
an assertion. Mailhog was the strongest documented lead and was rejected on the evidence: only
`orders` and `notifications` import `mailTestEnv` and no failure was ever in either.

**Also ruled out with measurements, all correctly, and all irrelevant:** OOM (Mongo 1.4–3.4 GiB of
7.75, no `exit 137`), connection-pool exhaustion (18 current against 101,562 available, measured
mid-symptom), accumulated state (14 databases), missing `--no-file-parallelism` (already set in
`vitest.config.ts`), a repository regression, and WiredTiger cache growth.

**The lesson worth keeping:** every eliminated cause was inside the boundary of this system, and the
answer was outside it. The one observation that did not fit — a request with no log line — was the
one pointing at the boundary itself, and it was treated as a measurement artifact for days before it
was treated as evidence.

**Why this is P2 and not higher.** It has never failed the same test twice, has never failed an
assertion about clinical or permission behaviour across six runs, and every failing suite has
passed on re-run and in isolation. Nothing suggests a product defect hiding behind it.

**Why it is not zero, either.** A gate that needs a second attempt trains people to re-run rather
than read, and the next real regression will arrive dressed as this one. **The mitigation is not to
raise `hookTimeout`** — that converts evidence into silence.

**Interaction with the CI decision.** This does not reopen it — CI is rejected before its first
step and no workflow change can fix that. It does mean the honest statement of the V1 gate is
_"green on a re-run, cause unknown"_, and the proportionate mitigation remains the one already
recorded: run `pnpm gate` once on a second machine before the pilot.

**Postscript, 2026-08-19 — a recurrence that was NOT T3, and did not reopen it.** One single-test
failure during a full gate, then nine green runs — the exact signature of this entry returning.
Three logged reproduction runs failed three for three and named two different causes, both inside
this system: a **500 on a concurrent ED triage** (an upsert losing to its own unique index with
nothing catching E11000 — a real product defect, now fixed and falsified) and a **harness race in
`dropDatabases`**, which returned before Mongo had finished dropping and killed a whole suite in
`beforeAll`. Neither is a port collision; T3's fix was verified still armed before the search
started. The lesson this entry already records held: the failure was found by keeping the output,
not by re-running until it passed. Written up in [`TESTING.md`](../../TESTING.md) §9.

**Left deliberately unfixed:** a preflight that fails the gate when foreign containers are up.
That was the shape of the retracted theory, and it would now be a control for a cause nobody has
established — enforcing a precondition that has not been shown to matter, on a host this repository
does not own.
