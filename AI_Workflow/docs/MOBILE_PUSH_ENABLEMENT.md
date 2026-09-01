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
| `app.config.ts` — `easProjectId()`                          | Accepts the id from `app.json` **or** `EAS_PROJECT_ID`. A dynamic config is one the CLI generally refuses to edit, so the id usually has to be placed by hand — and `app.json` is where it goes.                                                       |
| `app.config.ts` — `expo-notifications` plugin               | `mode` writes the iOS `aps-environment` entitlement (derived from the build profile); `defaultChannel: "default"` names the Android channel the app actually creates. Both verified via `expo prebuild`.                                               |
| `app.config.ts` — conditional `android.googleServicesFile`  | Referenced only when the file is present, so a checkout without Firebase credentials still builds and exports.                                                                                                                                         |
| `app.json` — emptied to `{}`                                | It held a stale `plugins` array that `app.config.ts` silently overrode. It is now purely somewhere for `eas init` to write.                                                                                                                            |
| `platform/pushNotifications.ts` — a reason on every failure | Four different situations produced an identical silence. On a bench you cannot debug that. Now logs `no-eas-project-id`, `permission-denied`, `unsupported-platform`, `no-token-issued` or `registrar-threw` — a reason only, never a token.           |
| `app.config.ts` — a startup line                            | `🔕 push: no EAS project id …` prints on every `expo start` until step 1 is done.                                                                                                                                                                      |
| `eas.json` — `environment` per profile                      | Binds each build profile to an EAS environment. Without it a server-side variable — including the Firebase config below — is never injected into the build.                                                                                            |
| `expo-dev-client` added                                     | `eas.json`'s `development` profile sets `developmentClient: true` and the package was not installed. A build without it cannot attach to Metro, which is the entire point of a development build.                                                      |
| root `.gitignore` — service-account key patterns            | A real FCM key downloads as `<project>-firebase-adminsdk-<hash>.json`; no existing rule matched that shape, so it would have been committed from anywhere in the tree.                                                                                 |     |

Nothing above mints a token. **Step 1 is the boundary; it needs your account.**

---

## 1. Link an EAS project — the blocker (B4-01)

```bash
npm i -g eas-cli          # or: pnpm add -g eas-cli
eas login                 # the Expo account that will own MediCore
cd apps/mobile
eas init
```

`eas init` creates the project and prints the id. A **dynamic** config — `app.config.ts` — is one
the CLI generally refuses to edit, so expect it to hand you the id rather than record it. Put it in
`apps/mobile/app.json`, which is `{}` and exists for exactly this (and if `eas init` already wrote
it there, leave it):

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
   phone. **Register all three** — realising later that the preview build has no Firebase app costs
   another round trip.

3. Download `google-services.json` → save to `apps/mobile/google-services.json`. It is gitignored
   with the signing material; do not commit it.

4. **Upload it to EAS as a file variable. This step is not optional and its absence is silent.**

   ```bash
   cd apps/mobile
   eas env:set --scope project --name GOOGLE_SERVICES_JSON --type file \
     --value ./google-services.json --visibility secret --environment development
   ```

   > **Why, and how this was found.** EAS Build uploads the project as a git archive, so a
   > **gitignored file is not in it**. Confirmed rather than assumed, with
   > `eas build:inspect --platform android --stage archive --profile development --output <dir>`,
   > which produces the exact tarball a build would receive: `google-services.json` was absent from
   > it. The build would still have SUCCEEDED — producing an app with no Firebase config, whose
   > `getExpoPushTokenAsync` fails, whose registration returns nothing, and which looks precisely
   > like a phone whose user declined the permission. Run `build:inspect` yourself if a build ever
   > produces an app that will not register; it answers "was the file even there" in ten seconds.
   >
   > `app.config.ts` reads `process.env.GOOGLE_SERVICES_JSON` and falls back to the local path, so
   > the same config works on a laptop, on EAS, and in a checkout that has neither. All three
   > branches are verified.
   >
   > Each build profile is bound to its environment in `eas.json` (`"environment": "development"`),
   > which is what makes a server-side variable reach the build at all. A profile without it gets
   > none of them.

5. Firebase Console → ⚙ **Project settings → Service accounts → Generate new private key**, then:

   ```bash
   cd apps/mobile
   eas credentials --platform android
   # → development → Google Service Account
   #   → Manage your Google Service Account Key for Push Notifications (FCM V1)
   #   → Set up a Google Service Account Key → point it at the downloaded file
   ```

   Upload the **service-account key**, not `google-services.json`. They are different files and
   swapping them is the commonest failure here: the build succeeds, a token mints, and every push
   comes back with a credentials error.

   **Delete the key from your disk afterwards.** It authorises sending push to every handset this
   hospital owns. The root `.gitignore` catches `*firebase-adminsdk*.json`,
   `*service-account*.json` and `*fcm*.json` anywhere in the tree, so a stray copy cannot be
   committed — but that is a seatbelt, not a reason to keep it.

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
pnpm --filter @medicore/api dev                    # runs the notifications worker in-process
pnpm --filter @medicore/api dev:device-domains     # once, and again after changing network
cd apps/mobile && pnpm start
```

`dev:device-domains` is the right way to make a handset reach this machine, and it is not obvious:
it attaches `<slug>.<your-ip>.sslip.io` to every local tenant as a **custom domain**, using the
same resolution path a hospital with its own hostname uses in production. Both hosts then work at
once — `apollo.localhost:4000` for the browser and `apollo.192.168.1.7.sslip.io:4000` for the
phone. Repointing `TENANT_BASE_DOMAIN` instead (as `MANUAL_VALIDATION_RUNBOOK.md` ENV-06 describes)
also works, but that value drives the dev CORS allowlist, so it moves the web app onto sslip URLs
for the rest of the session. Prefer the script.

Three more things have to be true, and it is easy to get two of the three:

1. **`REDIS_URL` is set for the API.** `push.deliver` is a queued task; with no Redis the in-app
   notification is still written and still delivered, and no push is ever scheduled. On a phone
   that is indistinguishable from broken push. The notifications worker runs inside the API process
   (`eventConsumer.ts`) — there is no separate service to start.
2. **`PUSH_ENABLED` is not `false`.** It defaults on.
3. **The tenant resolves before you pick up the phone.** A tenancy failure and a wifi failure look
   identical from a handset:

   ```bash
   curl -s -H 'Host: apollo.192.168.1.7.sslip.io' http://192.168.1.7:4000/api/v1/auth/login \
     -X POST -H 'Content-Type: application/json' -d '{}'
   # HMS-VAL-001 → tenant resolved, only credentials missing. Good.
   # HMS-TEN-001 → the host matched no tenant. Re-run dev:device-domains.
   ```

Then sign in on the phone as a doctor, accept the permission prompt, and confirm the registration
landed — from your machine, on the same account:

```bash
TOKEN=$(curl -s -H 'Host: apollo.192.168.1.7.sslip.io' -H 'Content-Type: application/json' \
  -d '{"email":"<doctor-email>","password":"<password>"}' \
  http://192.168.1.7:4000/api/v1/auth/login | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["accessToken"])')

curl -s -H 'Host: apollo.192.168.1.7.sslip.io' -H "Authorization: Bearer $TOKEN" \
  http://192.168.1.7:4000/api/v1/me/devices
```

One active device, platform `android`. If the list is empty, read the Metro console — the app now
logs `push unavailable` with a `code` saying which of the five reasons it was.

To fire an alert, record a **critical** result on web against an order that doctor placed. That is
the `order.critical` template, and it is the one the checklist's delivery rows assume.

## 5. Then run the checklist

`MOBILE_M4_DEVICE_CHECKLIST.md`, eighteen rows, in order. Tick only what you performed.

Two things to know before you start, so a real result is not mistaken for a bug:

- **M4-10 is the row that verifies K4-01.** It was going to fail — one Android channel at HIGH
  importance meant a routine result interrupted exactly like a critical one — and that was fixed
  on 2026-08-20. There are two channels now, `critical` and `default`, and the check is whether a
  released result arrives quietly while a critical one takes over the screen. It is the only place
  that can be confirmed.
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
