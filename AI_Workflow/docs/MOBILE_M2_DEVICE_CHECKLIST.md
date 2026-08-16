# MOBILE M2 — REAL-DEVICE VERIFICATION CHECKLIST

**Status:** the M2 doctor app is code-complete and green (1,613 mobile tests, 1,690 API integration
tests). Its server layer — auth, refresh rotation with reuse detection, logout revocation,
permission-driven navigation, branch selection, chart reads, prescription signing and
reconciliation — was pre-validated over real HTTP on 2026-08-14, **18 checks, all passing**.
**Nothing below has been exercised on physical hardware.** This is the list of what CI structurally
cannot prove, written so that whoever holds the phone can prove it.

> **Why this document exists as a checklist and not as a test run.** The M1/M2 test strategy is
> that everything worth defending lives outside React, so the suite runs in Node with no renderer,
> no simulator and no Android SDK. That buys speed and honesty, and it leaves exactly one category
> uncovered: anything whose failure is a rendered pixel, an OS prompt, or a real radio. A simulator
> does not close that gap — it has no enrolled fingerprint, no cellular modem and no app-switcher
> snapshot — so the gap is closed by a person with a device or it is not closed at all.

**Rule for filling this in: do not tick a hardware row you did not perform.** A row that was
skipped is more useful marked "not done" than marked "assumed fine".

---

## 0. Before you start

> ## 🔴 STEP ZERO — converge the database first
>
> ```bash
> pnpm seed:demo
> pnpm seed:migrate --all          # ← the one people skip
> pnpm seed:validation             # the ward, two sites, two zones
> pnpm seed:validation -- --verify # must print READY
> ```
>
> Migrations run inside hospital provisioning and `seed:demo` skips provisioning for a hospital that
> already exists, so an older database silently runs an older schema. Found on all four local
> tenants on 2026-08-14; it produced seven false safety failures that were purely the missing
> indexes. **§2 (branch) is meaningless without `seed:validation`** — it is what creates the second
> site and puts explicit timezones on both. (Risk register T2.)

|              |                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Build**    | `pnpm --filter @medicore/mobile start` — Expo Go is sufficient. No development build is needed: `expo-local-authentication@17.0.8` ships inside Expo Go on SDK 54 (it is in Expo's `bundledNativeModules.json` and publishes under `host.exp.exponent`).                                                                                                                                                                                                     |
| **API**      | A phone cannot reach `localhost`. Point `EXPO_PUBLIC_TENANT_DOMAIN` at a LAN IP or tunnel — `apps/mobile/README.md` §"A physical phone cannot use `localhost`" has the exact commands and the two-line curl that tells you whether the host resolved a tenant.                                                                                                                                                                                               |
| **Accounts** | `drrao@sunrise.test` (`123456`). `seed:validation` gives Sunrise its two active sites with explicit, materially different zones (`Asia/Kolkata` / `America/New_York`). For §6 you also need a hospital whose licence is inside its grace window — an operator-console change (`setLicense`, `extendDays: -1` past expiry with grace remaining), not a code change. **Not yet prepared: §6's five licence rows are BLOCKED until someone works the console.** |
| **Devices**  | At minimum one iOS with Face ID **and** one Android with a fingerprint reader. The lock's failure modes differ per platform in ways the port deliberately hides from the code.                                                                                                                                                                                                                                                                               |

---

## 1. AUTH

- [ ] **Login** with a correct password reaches the doctor's home, not a blank tab bar.
- [ ] **Login** with a wrong password says so _inline_ and does not clear the email field.
- [ ] **MFA**, where the account has it: the code screen appears and a wrong code is recoverable.
- [ ] **Cold start with a live session** restores straight into the app. There should be exactly one
      splash frame — never a flash of the sign-in screen, which would teach returning users to type.
- [ ] **Cold start after 30+ days** (or with the refresh token deleted server-side) lands on sign-in
      with a plain message, not a spinner that never resolves.
- [ ] **Token refresh mid-session**: leave the app open past the access token's 15 minutes, then tap
      something. It should just work, with no visible interruption.
- [ ] **Logout** returns to sign-in and the back gesture does **not** return to a chart.
- [ ] **Offline logout** — enable airplane mode, then sign out. It must complete locally within ~3
      seconds and still land on sign-in. This is the one that fails silently if the timeout regresses.

## 2. BRANCH

- [ ] Branch A is shown in the header on arrival, and it is the **validated** one — not merely the
      one remembered from last time.
- [ ] Switching to branch B changes every list on screen. Nothing from A survives the switch.
- [ ] Switching back to A re-reads rather than showing a stale frame of the previous data.
- [ ] A branch that an administrator sets to **inactive** while you are in it: on next resume the app
      must fall back to a valid branch rather than keep sending the dead one.
- [ ] **All-branches** (if the account can aggregate): lists span sites; every write screen shows
      "Choose which site you are working at before saving" with the save control disabled.
- [ ] Deep-link into a chart (`/patient/<id>`) while in branch B — a record belonging to A must come
      back "not available here", never render.

## 3. CLINICAL — read

- [ ] Patient list loads, pages on scroll, and shows a real empty state (not a blank page) for a
      doctor with nobody booked.
- [ ] A chart opens: identity line reads **name → UHID → age/sex**, in that order, and the UHID is
      readable digit by digit at arm's length.
- [ ] **Age is the hospital's**, not the phone's. Set the device to a timezone a day ahead
      (Pacific/Kiritimati) and confirm a patient's age does not change. _(Fixed in L; this is the
      manual confirmation.)_
- [ ] Vitals render with the server's own flags — nothing on the phone re-assesses a number.
- [ ] An **unreleased** result shows its status ("Awaiting verification"), and no values.
- [ ] A **released critical** result is visibly flagged and sorted to the top.
- [ ] Timestamps carry the branch's zone label. Change the device timezone and confirm they do not
      move.
- [ ] Long patient name, long medication name and a 2000-character clinical note each wrap or
      truncate — they must not push the identity line off screen.
- [ ] Smallest supported screen (iPhone SE / a 5" Android): the tab bar, header and save controls
      are all reachable with one thumb.

## 4. CLINICAL — write

- [ ] **Consultation**: type, leave the screen, confirm the "discard unsaved changes?" prompt fires
      on the header chevron, the hardware back button **and** an edge swipe.
- [ ] **Consultation**: save, then confirm the status pill reads "Saved HH:MM" in the branch's zone.
- [ ] **Consultation**: save while offline — the pill must read **"Not saved"** and the typed words
      must still be on screen.
- [ ] **Order pad**: place three tests; confirm three separate requests and a clear per-item result.
- [ ] **Prescription**: compose → review → sign. A safety alert must present as a review step, not
      as a failed save.
- [ ] **Prescription signing, response lost**: sign, and kill the network the instant you tap.
      Re-open the prescription. It must say **signed** if the server signed it — reconciled from
      `signedAt`, never from a retry that could double-sign.
- [ ] **Ward note**: write one, confirm it appears on the timeline with your name and the time.
- [ ] **Ward note, response lost**: same trick. The app must either say the note is on the chart, or
      say plainly that it does not know — and must never claim "saved" without evidence.
- [ ] **Discharge**: the confirmation step is explicit and the summary text survives a failure.
- [ ] Every disabled save control **says why**. A bare greyed-out button is a defect.

## 5. SECURITY — the lock (M2 K)

**None of this section has ever run on hardware.** It is the largest single block of unverified
behaviour in M2.

- [ ] Turn the screen lock **on** in Settings. On a device with no enrolled fingerprint or face it
      must still turn on — and say so plainly ("unlocking will use your password"). Capability
      decides the _method_, never whether to lock; a toggle that refused would leave the device most
      in need of a gate without one.
- [ ] Background the app for **under 15 minutes**, resume → straight back in, no prompt.
- [ ] Background for **over 15 minutes**, resume → the gate is the **first frame**. The chart must
      not be visible for even a moment before it.
- [ ] The OS prompt appears **by itself**, without a tap.
- [ ] **Successful** Face ID / fingerprint → app returns, cache still warm, no network round trip.
- [ ] **Failed** scan (wrong finger) → stays locked, counter decrements, session survives.
- [ ] **Cancelled** prompt (dismiss it) → stays locked, counter does **not** move. This is the one
      that would drive people to switch the feature off if it regressed.
- [ ] **"Use password"** on the OS sheet → the app offers the password path, no attempt spent.
- [ ] **Five failed scans** → signed out cleanly, landing on sign-in and not on a dead lock screen.
- [ ] **Sign out** from the lock screen works on the very first render.
- [ ] **No enrolled biometric** (remove it in device Settings while the app is backgrounded, then
      resume): the gate still comes up and offers the password path. It must **not** silently unlock.
- [ ] **App switcher**: the snapshot shows the privacy cover, not a patient.
- [ ] **Force-quit and relaunch** while locked → the session resumes normally; the lock does not
      persist across a cold start (there is no PHI on screen to protect at that point).

## 6. SECURITY — the licence (M2 L)

- [ ] **Healthy licence**: no banner anywhere.
- [ ] **EXPIRING** (inside `LICENSE_WARN_DAYS`): an amber strip above the tab bar with a day count.
      **Check the layout** — the banner is new in L and its placement above the navigator has not
      been seen on a device.
- [ ] **GRACE**: a red strip — and every clinical write **still works**. This is deliberate: a
      hospital the server is still serving must still be able to record what was done to a patient.
- [ ] **EXPIRED** (past grace): every screen shows "Subscription expired" as a blocking state, and
      save controls are disabled with that reason rather than failing after the tap.
- [ ] **Renewal mid-session**: have an operator renew while the app is open, then pull to refresh.
      The block must clear without a restart.

## 7. NETWORK

- [ ] **Airplane mode** on a list screen → an explained offline state with a retry, never a blank
      page.
- [ ] **Airplane mode** on a write screen → the save control is disabled and says the device is
      offline.
- [ ] **Server unreachable** (stop the API, leave wifi up) → "cannot reach the hospital's system",
      not "no internet". These are genuinely different and the app distinguishes them.
- [ ] **Slow network** (Network Link Conditioner / a throttled hotspot): loading states appear and
      resolve; no screen sits blank.
- [ ] **Response lost after a mutation** — covered per-write in §4, but do it at least once on a
      real cellular handover (walk out of wifi range mid-save).
- [ ] **Backgrounded during a save**: the mutation must be allowed to finish. Cancelling it mid-flight
      is exactly the ambiguity `Idempotency-Key` exists to resolve.

## 8. Accessibility

- [ ] Largest OS text size: the identity line, the save controls and the lock screen all remain
      usable. Nothing critical clips.
- [ ] VoiceOver / TalkBack: the allergy banner and the lock screen's attempt warning are announced
      as alerts rather than being walked onto.
- [ ] Every tappable target is comfortably hittable with a thumb — the tokens set 48pt, but only a
      hand confirms it.
- [ ] Sunlight or high-brightness: the amber/red banner tones and the critical-result flag are
      distinguishable.

---

## What CI already proves, so you do not need to re-check by hand

Listed so this checklist stays short enough to actually be done:

- Branch isolation, including that a switch leaves nothing of the previous site in the cache
  (falsified: removing the cache clear turns 5 tests red).
- Every branch-sensitive query key carries `[tenant, branch]`, and no two keys in the table collide
  (falsified: 15 red).
- Timestamps and day keys resolve through the branch's zone against a machine deliberately in a
  different one (falsified: 2 red).
- The result release gate and the server-owned critical flag (falsified: 6 and 5 red).
- Prescription reconciliation via `signedAt`, never `status` (falsified: 4 red).
- Ward-note idempotency keys and the reconciliation on top of them (falsified: 2 red).
- Concurrent 401s produce exactly one refresh; a failed refresh ends the session once (falsified: 4 red).
- The lock's attempt ladder, all 14 OS refusal codes, and that a cancel costs nothing (falsified: 1 red).
- The licence state machine across both server channels (falsified: 1 + 4 + 3 red).
- No PHI reaches disk, a log, or an analytics SDK (falsified: 1 red).

The gap between that list and this checklist is precisely: **rendered layout, OS prompts, and real
radios.**
