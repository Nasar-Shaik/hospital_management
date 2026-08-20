# MOBILE M4 — STAFF PUSH: REAL-DEVICE VERIFICATION CHECKLIST

**Status: 🔴 BLOCKED — 0 of 18 performed. The repository side is now clear; what remains is an
Expo account, a build and a phone (see §0 and `MOBILE_PUSH_ENABLEMENT.md`).**

M4 is engineering-complete on automated evidence: 27 API integration tests drive the real push path
against a loopback server speaking Expo's protocol, 9 unit tests pin the two pure decisions, and 15
mobile tests drive the real runtime against a fake notification service. **Not one of them can prove
that a phone rings**, and nothing in this repository can. That is not a gap in the tests; it is
where the automated boundary genuinely ends.

> **Do not tick a row you did not perform.** A row marked "not done" is more useful than one marked
> "assumed fine". M2's 61 rows and M3's 45 are still unticked and remain prerequisites for anything
> auth-, lock- or branch-related here.

---

## 0. Prerequisites — what is closed, and what still needs you

`AI_Workflow/docs/MOBILE_PUSH_ENABLEMENT.md` is the runbook with the exact commands. In short:

| #     | Prerequisite                                                                                                                                                                        | State                                                                                                                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B4-01 | **An EAS project.** `getExpoPushTokenAsync` cannot mint a token without `extra.eas.projectId`, so until this exists the app registers no device and every row below is unreachable. | 🟡 **plumbed, not populated.** The config now carries an id from `app.json` or `EAS_PROJECT_ID` — and a `🔕` line at startup says when it has neither. Someone with the Expo account must run `eas init`. |
| B4-02 | **A development build.** Expo Go has not carried remote push since SDK 53. `eas.json`'s `development` profile is ready and unmodified.                                              | 🔴 **external.** `eas build --profile development --platform android`, after B4-01.                                                                                                                       |
| B4-03 | **Apple Developer Program**, $99/yr, for iOS push credentials and device registration.                                                                                              | 🔴 **external, and optional for now** — it blocks 4 of the 18 rows, not the other 14.                                                                                                                     |
| B4-04 | **A Firebase project + FCM V1 service-account key**, for Android delivery. `android.googleServicesFile` is referenced conditionally, so a checkout without it still builds.         | 🔴 **external.** Free.                                                                                                                                                                                    |

**The defect that was found while closing B4-01, and would have wasted the first device session:**
`app.config.ts` rebuilt its `extra` object from scratch, with no `...config.extra`. Anything
`eas init` wrote to `app.json` was silently discarded on the way through — the repository would
have shown a linked project, `expo config` would have shown none, and the app would have gone on
returning `undefined` with nothing logged anywhere. Same shape as the colon in the BullMQ job id: a
step that reports success and does nothing.

Until B4-01 and B4-02 are closed, the honest status of push on hardware is **not "failing" —
untested**, and it must be reported that way.

---

## 0b. Two rows that are already known not to pass

Recorded here so a real defect is not rediscovered as a surprise, and so neither is quietly ticked.

| Item  | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K4-01 | **M4-10 cannot pass as written.** `push.service.ts` sends `priority: "high" \| "default"`, but `platform/pushNotifications.ts` creates ONE Android channel at HIGH importance, and on Android 8+ the channel decides interruption, not the priority. A routine result will buzz exactly like a critical one. Fixing it means a second channel and a `channelId` on the message — a change to notification channels, which M4 was told not to make. Left as a decision, not made silently. |
| K4-02 | **Biometrics is wired to nothing.** `RuntimeProvider` passes `secureStore`, `preferences`, `push` and `logger` to `createRuntime` — and not `biometrics`. `platform/biometrics.ts` is therefore imported by no shipping code, `runtime.biometrics` is always undefined, and the M2 screen lock can only ever ask for a passcode. One line. Unrelated to push, so not fixed under M4; it needs the same hardware session, so it belongs in the same booking.                               |

---

## 1. Registration (5) — MANUAL REQUIRED

| #     | Check                                                                                                      | Result |
| ----- | ---------------------------------------------------------------------------------------------------------- | ------ |
| M4-01 | On first sign-in the OS permission prompt appears once, and only once                                      | ☐      |
| M4-02 | Accepting it registers the handset — `GET /me/devices` on the same account lists exactly one active device | ☐      |
| M4-03 | **Declining it changes nothing else.** Sign-in completes, every tab works, the Alerts inbox is populated   | ☐      |
| M4-04 | Signing out and in again does not create a second row (the register is an upsert keyed on the token)       | ☐      |
| M4-05 | Killing and relaunching the app re-registers without a second prompt                                       | ☐      |

## 2. Delivery (6) — MANUAL REQUIRED

| #     | Check                                                                                                                                                         | Result |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M4-06 | A critical result recorded on web arrives on the phone **within seconds**, app in the foreground                                                              | ☐      |
| M4-07 | …with the app **backgrounded**                                                                                                                                | ☐      |
| M4-08 | …with the app **force-quit**                                                                                                                                  | ☐      |
| M4-09 | …with the screen **locked**, and the banner shows "Critical result" — **no patient name, no test name, no value**                                             | ☐      |
| M4-10 | A routine released result arrives, and does NOT interrupt the way a critical one does (Android: default vs high importance) — **expected to FAIL, see K4-01** | ☐      |
| M4-11 | Airplane mode for ten minutes, then back: the alert arrives late rather than never, and the inbox had it all along                                            | ☐      |

## 3. The tap (4) — MANUAL REQUIRED

| #     | Check                                                                                                                              | Result |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M4-12 | Tapping a foreground banner opens **that order**, not the alerts list                                                              | ☐      |
| M4-13 | Tapping a notification that **launches the app from cold** lands on the same screen (this is the half a listener alone would miss) | ☐      |
| M4-14 | Tapping while **signed out** lands on the login screen, and the alert is still in the inbox afterwards                             | ☐      |
| M4-15 | Tapping a message about something this build cannot open lands on Alerts, not on a blank screen                                    | ☐      |

## 4. The lifecycle (3) — MANUAL REQUIRED

| #     | Check                                                                                                                      | Result |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| M4-16 | After signing out, a new alert for that account does **not** reach the handset                                             | ☐      |
| M4-17 | **The shared-phone case.** Sign in as A, sign out, sign in as B. An alert for A must not arrive; an alert for B must       | ☐      |
| M4-18 | Uninstalling the app retires the token: the next alert logs `DeviceNotRegistered` and `GET /me/devices` no longer lists it | ☐      |

---

## What the automated suites DO cover, so this list stays honest about its own value

Everything up to the last hop. `push.int.test.ts` drives the real service against a loopback server
speaking Expo's protocol: registration, reassignment on a shared handset, release, ownership,
tenant isolation, the payload's contents, priority, ticket errors, `DeviceNotRegistered` retirement,
partial-batch behaviour, and the scheduling itself (asserted on the queued BullMQ job).
`pushCopy.test.ts` pins what a locked screen may say. `push.test.ts` on mobile drives the real
runtime for registration, release and the deep-link mapping.

**None of that can see:** an OS permission dialog, a notification arriving, a banner's rendered
text, a lock screen, Doze or Low Power Mode, a cold-start tap, or an APNs/FCM token that Expo's
sandbox accepts and the production one does not. Those eighteen rows are the milestone's real
remaining risk, and they are all above.
