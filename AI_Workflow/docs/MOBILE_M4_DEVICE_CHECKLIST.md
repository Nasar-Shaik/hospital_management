# MOBILE M4 — STAFF PUSH: REAL-DEVICE VERIFICATION CHECKLIST

**Status: 🔴 BLOCKED — 0 of 18 performed, and the first two cannot be performed at all yet.**

M4 is engineering-complete on automated evidence: 27 API integration tests drive the real push path
against a loopback server speaking Expo's protocol, 9 unit tests pin the two pure decisions, and 15
mobile tests drive the real runtime against a fake notification service. **Not one of them can prove
that a phone rings**, and nothing in this repository can. That is not a gap in the tests; it is
where the automated boundary genuinely ends.

> **Do not tick a row you did not perform.** A row marked "not done" is more useful than one marked
> "assumed fine". M2's 61 rows and M3's 45 are still unticked and remain prerequisites for anything
> auth-, lock- or branch-related here.

---

## 0. Two blockers, before any of this can start

| #     | Blocker                                                                                                                                                                                                                                                                                                                                                    | Owner   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| B4-01 | **No EAS project is linked.** `extra.eas.projectId` is set nowhere in this repository, and `getExpoPushTokenAsync` cannot mint a token without it. `platform/pushNotifications.ts` returns `undefined` in that case — correctly, and silently — so **the app will register no device until this is done**, and every row below is unreachable. `eas init`. | release |
| B4-02 | **Expo Go cannot receive remote push from SDK 53 onward.** A development build (`eas build --profile development`) is required. This is a different question from M2's — that one asks whether `expo-local-authentication` runs inside Expo Go, and the answer there may well be yes. This one is settled by Expo's own release notes: for push, it is no. | release |

Until both are closed the honest status of push on hardware is **not "failing" — untested**, and it
must be reported that way.

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

| #     | Check                                                                                                                       | Result |
| ----- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| M4-06 | A critical result recorded on web arrives on the phone **within seconds**, app in the foreground                            | ☐      |
| M4-07 | …with the app **backgrounded**                                                                                              | ☐      |
| M4-08 | …with the app **force-quit**                                                                                                | ☐      |
| M4-09 | …with the screen **locked**, and the banner shows "Critical result" — **no patient name, no test name, no value**           | ☐      |
| M4-10 | A routine released result arrives, and does NOT interrupt the way a critical one does (Android: default vs high importance) | ☐      |
| M4-11 | Airplane mode for ten minutes, then back: the alert arrives late rather than never, and the inbox had it all along          | ☐      |

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
