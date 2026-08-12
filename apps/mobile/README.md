# @medicore/mobile — Staff Mobile App (M1 foundation)

The React Native staff application. **M1 is the foundation only**: sign in, stay signed in, know
who you are, know which site you are at, and fail comprehensibly. No clinical or financial workflow
ships here — those are M2 onward. See
[MOBILE_M0_ARCHITECTURE.md](../../AI_Workflow/docs/MOBILE_M0_ARCHITECTURE.md) for the approved
architecture; this README covers only what is specific to running and extending the code.

## Why this app is on Expo SDK 54 and not the latest

**Pinned to match the other Expo app on the team's phones.** Expo Go serves exactly one SDK per
app version, and this team also develops `school_management/mobile`, which is on SDK 54. The Play
Store's Expo Go was 54.0.8 when M1 was built — SDK 57 was not installable at all — so an app on 57
could not be opened on a real device without either breaking the ERP or building a custom dev
client.

SDK 54 is still supported by Expo, so this is a currency decision rather than a security one. It
carries a real cost (RN 0.81 rather than 0.86) and it is **temporary**:

- **Upgrade when** the ERP moves to the same SDK, or when this app moves to a development build —
  which it must do by **M2 anyway**, because `expo-local-authentication` (the biometric gate) does
  not work in Expo Go, and certainly by M4 for push.
- **Do not raise the SDK alone.** Raising it silently costs whoever is holding a phone the ability
  to run the app. Move both projects, or move to a dev client first.

M0 §1 said "the current supported Expo SDK at M1", which this satisfies — the constraint that
decided _which_ supported SDK is recorded here.

## The one structural rule

```
src/lib · src/state · src/query · src/navigation      NO react-native, NO expo imports
        ↑ depends on interfaces only
src/platform                                          Keychain · AsyncStorage · Constants · Platform
app/ · src/components · src/hooks · src/providers      React
```

The session lifecycle, branch restoration, error mapping and permission-to-navigation logic are
plain TypeScript. That is why `__tests__` runs them in Node against the real
`@medicore/api-client`, on CI, with no simulator, no Xcode and no Android SDK — and it is enforced
by `.dependency-cruiser.cjs`, not by convention.

The two edges a phone owns are the two things a test substitutes: `fetch` and the Keychain.
Everything between them is the shipping code.

## Commands

```bash
pnpm --filter @medicore/mobile start        # Expo dev server
pnpm --filter @medicore/mobile test         # the foundation suite (no device needed)
pnpm --filter @medicore/mobile typecheck
pnpm --filter @medicore/mobile lint
```

`pnpm gate` at the repo root runs all of the above along with everything else.

## Pointing it at an API

There is no hospital baked into the binary — one build serves every hospital, and the user picks
one on first launch (M0 §6). What the build decides is the DOMAIN those slugs resolve against, and
whether plain HTTP is permitted at all:

| Profile       | `EXPO_PUBLIC_ENV` | Base URL for slug `apollo`                |
| ------------- | ----------------- | ----------------------------------------- |
| `development` | `development`     | `http://apollo.localhost:4000`            |
| `preview`     | `staging`         | `https://apollo.staging.paperlesstech.in` |
| `production`  | `production`      | `https://apollo.paperlesstech.in`         |

Only `development` can produce an `http://` URL, and there is no runtime setting that changes it.

For local work, run the API (`pnpm docker:dev` then `pnpm --filter @medicore/api dev`), provision a
tenant, and enter its slug. A simulator resolves `*.localhost` to the host machine; a physical
device does not — use your machine's LAN address in `app.config.ts`'s development entry.

## Running it on a real phone

```bash
pnpm --filter @medicore/mobile start        # add -c after changing config or resolving imports
pnpm --filter @medicore/mobile bundle:check # bundles both platforms headlessly — no device
```

`bundle:check` is the one that matters in review. **Typecheck and the test suite can both pass on
code Metro cannot bundle**, because TypeScript and Vite resolve `./foo.js` to `foo.tsx` and Metro
does not. Run it before claiming the app starts.

`java.io.IOException: Failed to download remote update` on Android (a bare "Something went wrong"
on iOS) is Expo Go's message for **both** of the causes below. It names neither, and both look
exactly like a wifi problem. They were hit in that order during M1; the first fix alone did not
help, which is worth knowing before chasing the network a second time.

#### 1. `runtimeVersion` must be absent in development

Expo Go runs one native runtime — its own — and identifies it as `exposdk:<version>`. A project
that advertises any **other** `runtimeVersion` is telling every client "you need a matching
development build", and Expo Go refuses the manifest.

`app.config.ts` therefore sets `runtimeVersion` only for `preview` and `production`, the two
profiles that actually receive EAS Updates (M0 §17). Nothing is lost: updates are never served to
a development build, so the field has no meaning there. **Do not "tidy up" that conditional.**

Verify by asking the dev server what Expo Go asks it:

```bash
curl -s -H "expo-platform: android" -H "accept: multipart/mixed,application/expo+json,application/json" \
  http://<your-ip>:19000/ | grep -o '"runtimeVersion":"[^"]*"'
# exposdk:57.0.0  → Expo Go can load it
# 0.1.0           → Expo Go will refuse it
```

#### 2. Why the dev server runs on 19000

8081 is the React Native default, so every Expo project on a machine wants it — and this team runs
a second one (the School ERP) alongside this app. Its service fleet holds 8080–8090, which is why
8082 was no better than 8081.

The collision does not fail loudly. The first process takes IPv4; Metro starts anyway and binds
**IPv6**, warning nobody that it did not get the port it asked for. The QR still advertises the
IPv4 address, so the phone reaches the _other_ project's server and asks a camera service for an
Expo manifest.

19000 is Expo's own historic port and is clear of that range. If it is ever occupied:

```bash
lsof -nP -iTCP:19000 -sTCP:LISTEN   # who else is here
curl http://<your-ip>:19000/        # must be an Expo manifest, not another app's JSON
```

#### 3. Everything else

- **Phone and Mac not on the same network**, or wifi client isolation. Open
  `http://<your-ip>:19000` in the phone's browser. `pnpm start:tunnel` works around it.
- **A stale Metro cache** after changing `app.config.ts`, `metro.config.js` or import paths. The
  terminal has the real error; `start -c` clears it.
- **Expo Go older than the project's SDK.** This app is on SDK 57.

## Things that will bite

- **`Asia/Kolkata` is not in `Intl.supportedValuesOf("timeZone")`.** That list carries the legacy
  `Asia/Calcutta`. Meanwhile `Intl.DateTimeFormat` happily accepts `IST`, `EST` and `+05:30` and
  silently resolves them to the wrong thing. `isValidZone` in `src/lib/time.ts` handles both traps;
  do not "simplify" it to either single check. Same warning applies to backend item E.
- **Metro and pnpm.** `metro.config.js` teaches Metro about the workspace root and both
  `node_modules` trees. If a transitive React Native dependency ever fails to resolve, the
  documented fix is `node-linker=hoisted` in the ROOT `.npmrc` — it is workspace-wide, not per-app.
- **Peer warnings on install.** `@react-native/metro-config` and `react-native-worklets` report
  unmet peers against the SDK's pinned versions. Both are transitive, neither affects the gate.
- **Never construct a second `ApiClient`.** `src/lib/apiClient.ts` is the only place, and a lint
  rule plus a boundary rule guard the storage equivalents. If the client is missing something, add
  it to `packages/api-client` where `client:check` can see it.
