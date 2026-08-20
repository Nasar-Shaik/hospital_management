# ENABLING PUSH ON REAL HARDWARE — THE M4 RUNBOOK

**Who this is for:** whoever holds the Expo account and a phone. Everything in this document that
can be done in code has been done; what remains needs an account, a device, and about an hour.

M4's engineering is complete and gated. Its 18 device checks
(`MOBILE_M4_DEVICE_CHECKLIST.md`) have never run, because a push token cannot be minted in this
environment. This is the shortest correct path to the point where they can.

---

## 0. What changed in the repository, so you are not looking for it

| Change                                                      | Why it was blocking                                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app.config.ts` — `extra: { ...config.extra, … }`           | **The one that mattered.** `extra` was rebuilt from scratch, so anything `eas init` wrote to `app.json` was discarded on the way through. You would have linked a project, seen it in the repo, and still had no token — with nothing logged anywhere. |
| `app.config.ts` — `easProjectId()`                          | Accepts the id from `app.json` **or** `EAS_PROJECT_ID`. `eas init` cannot write into a dynamic config; it writes `app.json` and prints a note that is easy to miss.                                                                                    |
| `app.config.ts` — `expo-notifications` plugin               | `mode` writes the iOS `aps-environment` entitlement (derived from the build profile); `defaultChannel: "default"` names the Android channel the app actually creates. Both verified via `expo prebuild`.                                               |
| `app.config.ts` — conditional `android.googleServicesFile`  | Referenced only when the file is present, so a checkout without Firebase credentials still builds and exports.                                                                                                                                         |
| `app.json` — emptied to `{}`                                | It held a stale `plugins` array that `app.config.ts` silently overrode. It is now purely somewhere for `eas init` to write.                                                                                                                            |
| `platform/pushNotifications.ts` — a reason on every failure | Four different situations produced an identical silence. On a bench you cannot debug that. Now logs `no-eas-project-id`, `permission-denied`, `unsupported-platform`, `no-token-issued` or `registrar-threw` — a reason only, never a token.           |
| `app.config.ts` — a startup line                            | `🔕 push: no EAS project id …` prints on every `expo start` until step 1 is done.                                                                                                                                                                      |

Nothing above mints a token. **Step 1 is the boundary; it needs your account.**

---

## 1. Link an EAS project — the blocker (B4-01)

```bash
npm i -g eas-cli          # or: pnpm add -g eas-cli
eas login                 # the Expo account that will own MediCore
cd apps/mobile
eas init
```

`eas init` creates the project and prints the id. Because the config is dynamic it **cannot write
it for you** — put it in `apps/mobile/app.json`, which exists for exactly this:

```json
{
  "owner": "<your-expo-account-or-org>",
  "extra": { "eas": { "projectId": "<the-uuid-eas-printed>" } }
}
```

`owner` is only required if the project lives under an organisation, but setting it is harmless and
prevents a build being created under a personal account by accident.

**Verify before going further:**

```bash
cd apps/mobile && npx expo config --type public --json | grep -A2 '"eas"'
```

You want the uuid back. `pnpm start` should now print `🔔 push: EAS project <uuid> …`. If it still
prints `🔕`, the id is not reaching the app and no later step will work.

Cost: free. An Expo account is enough — EAS Build's free tier is queued but sufficient.

---

## 2. Pick a platform. Start with Android.

Not a style preference — a cost one:

|                     | Android                       | iOS                                   |
| ------------------- | ----------------------------- | ------------------------------------- |
| Developer account   | none                          | **Apple Developer Program, $99/year** |
| Device registration | none — sideload the APK       | device UDID must be registered        |
| Push credentials    | FCM V1 service account (free) | APNs key (needs the paid account)     |
| Time to first buzz  | ~30 min                       | ~90 min, most of it Apple's           |

Fourteen of the eighteen checks are platform-independent. **Run them on Android first**, and treat
iOS as a second pass whose real purpose is the four rows Android cannot answer — APNs
sandbox-versus-production, and the iOS permission dialog.

If there is no paid Apple account today, that is not a blocker for M4; it is a blocker for the iOS
half of it, and should be recorded as such rather than holding up the other fourteen.

### 2a. Android — Firebase (B4-04)

Expo push reaches Android through FCM, so a Firebase project is required even though no other
Firebase feature is used.

1. <https://console.firebase.google.com> → **Add project** (analytics not needed).
2. **Add app → Android**. The package name must match exactly:
   - development build: `in.paperlesstech.medicore.development`
   - preview build: `in.paperlesstech.medicore.staging`
   - production: `in.paperlesstech.medicore`

   These come from `app.config.ts` and differ per profile deliberately, so all three can sit on one
   phone. **Register all three now** — realising later that the preview build has no Firebase app
   costs another round trip.

3. Download `google-services.json` → save to `apps/mobile/google-services.json`. It is gitignored
   with the signing material; do not commit it.
4. Firebase Console → ⚙ **Project settings → Service accounts → Generate new private key**. This
   downloads a JSON file. Then:

   ```bash
   cd apps/mobile
   eas credentials --platform android
   # → the profile → Google Service Account → Manage → Upload a new key
   ```

   Upload the service-account JSON, **not** `google-services.json`. They are different files and
   swapping them is the commonest failure here: builds succeed, tokens mint, and every push returns
   a credentials error.

### 2b. iOS — Apple (B4-03), only if you have the paid account

```bash
cd apps/mobile
eas credentials --platform ios     # let EAS create the APNs key and provisioning profile
```

Register the test device first, or the build will install and refuse to launch:

```bash
eas device:create                  # follow the link on the phone itself
```

---

## 3. Build the development client (B4-02)

Expo Go has not carried remote push since SDK 53. There is no workaround; a development build is
the requirement.

```bash
cd apps/mobile
eas build --profile development --platform android
```

The `development` profile in `eas.json` already sets `developmentClient: true`,
`distribution: "internal"` and `EXPO_PUBLIC_ENV=development`. EAS prints a QR code and an install
URL when it finishes; open it on the phone.

**Monorepo note.** This is the first EAS build this repository has ever run. It is a pnpm workspace
with `workspace:*` dependencies, so the build uploads the whole repo and installs from the root
lockfile. That normally works; if resolution fails inside the build, the documented escape hatch is
already written down in `apps/mobile/metro.config.js` — `node-linker=hoisted` in the **root**
`.npmrc`. Budget one failed build for this and do not be alarmed by it.

iOS simulator builds are also possible (`"ios": { "simulator": true }` is already set) — useful for
UI work, useless for push. A simulator has no APNs.

---

## 4. Point the phone at an API that can send

```bash
pnpm --filter @medicore/api dev      # runs the notifications worker in-process
cd apps/mobile && pnpm start         # note the TENANT_BASE_DOMAIN line it prints
```

Three things have to be true at once, and they are easy to get two out of three:

1. **`apps/api/.env` has `TENANT_BASE_DOMAIN` set to whatever `pnpm start` printed.** It is derived
   from your current LAN address via `sslip.io`, so it changes when you change network.
2. **`REDIS_URL` is set for the API.** `push.deliver` is a queued task; with no Redis the in-app
   notification is still written and delivered and no push is ever scheduled. This looks exactly
   like a broken phone. The notifications worker runs inside the API process
   (`eventConsumer.ts`), so there is no separate service to start.
3. **`PUSH_ENABLED` is not `false`.** It defaults on.

Then, on the phone: sign in as a doctor, accept the permission prompt, and confirm registration
landed — from your machine, against the same account:

```bash
curl -H "Host: <slug>.<domain>" -H "Authorization: Bearer <token>" \
  http://localhost:4000/api/v1/me/devices
```

One active device, platform `android`. If the list is empty, read the Metro console: the app now
logs `push unavailable` with a reason.

To fire an alert, record a critical result on web for a patient whose order that doctor placed —
that is the `order.critical` template, and it is the one the checklist's delivery rows use.

---

## 5. Then run the checklist

`MOBILE_M4_DEVICE_CHECKLIST.md`, eighteen rows, in order. Tick only what you performed.

Two things to know before you start, so a real result is not mistaken for a bug:

- **M4-10 will not pass as written.** The server sends `priority: high | default`, but the app
  creates a single Android channel at HIGH importance, and on Android 8+ the channel — not the
  priority — decides whether a notification interrupts. Routine and critical will behave
  identically. This is a real M4 defect, found while writing this runbook, and deliberately not
  fixed here: it is a change to notification channels, which this milestone was told not to make.
  Record the row as FAILED with that reason.
- **Biometric rows in the M2 checklist cannot pass either.** `RuntimeProvider` never passes
  `biometrics` to `createRuntime`, so `platform/biometrics.ts` is imported by nothing and the
  screen lock can only ever ask for a passcode. One line, unrelated to push, still open — see the
  known-items section of the M4 checklist.

---

## The account and cost summary, in one place

| Prerequisite                           | Cost   | Blocks                  |
| -------------------------------------- | ------ | ----------------------- |
| Expo account + `eas init`              | free   | **everything**          |
| Firebase project + service-account key | free   | all Android delivery    |
| A physical Android phone               | —      | 14 of 18 rows           |
| Apple Developer Program                | $99/yr | the 4 iOS-specific rows |
| A physical iPhone                      | —      | the same 4              |
