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
  needed by **M4** for push, since Expo Go dropped remote push on Android from SDK 53.
- **Do not raise the SDK alone.** Raising it silently costs whoever is holding a phone the ability
  to run the app. Move both projects, or move to a dev client first.

> **Correction (2026-08-14): this file used to claim M2 forces a development build because
> `expo-local-authentication` "does not work in Expo Go". That is very likely wrong.** SDK 54's own
> `bundledNativeModules.json` lists `expo-local-authentication: ~17.0.8`, exactly the version
> installed here — i.e. it is one of the modules Expo Go ships. The claim was never tested on a
> device; it propagated into `projectTracker.md` and set the expected setup cost for M2 validation.
> The M2 device checklist takes the opposite position with that evidence. **Settle it on hardware in
> the first five minutes of the next device session and correct whichever document is wrong.** On
> iOS expect the Face ID prompt to be worded as Expo Go's, which is cosmetic.

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

## Every new route needs `requireRuntime`

There is no runtime until a hospital is chosen, and `useRuntime`, `useSession`, `useBranch`,
`useConnectivity` and `useCapabilities` all read it. A screen that calls any of them without a
guard **throws on its own first render** — and on a fresh install that is the very first thing the
user sees, because Expo Router resolves `/` to `(app)/index`.

```tsx
function MyScreen(): React.JSX.Element { … }
export default requireRuntime(MyScreen);
```

Screens inside `app/(app)/` inherit the guard from the group layout and need nothing of their own.
Everything beside it — a new `app/*.tsx` — needs its own.

The check cannot live inside the screen: those hooks run before its first `return`, so by the time
it could test for a runtime it has already thrown. It also cannot be an effect, for the same reason
in slower motion. `__tests__/routes.test.ts` walks `app/` and fails with the file name if a route
reads the runtime with nothing above it guarding — which is the only automated cover this class
has, since the suite renders nothing.

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
tenant, and enter its slug. The **hospital code is the tenant slug** — the subdomain, not a URL and
not a password. `pnpm --filter @medicore/api provision` creates one.

### A physical phone cannot use `localhost`

A simulator shares the Mac's loopback, so `apollo.localhost:4000` works there and this problem
never shows up. On a handset `apollo.localhost` resolves to **the phone**, which is not running the
API, so every request fails no matter how good the wifi is.

An IP does not fix it either: the server reads the tenant out of the **subdomain**
(`slugFromHost` in `resolveTenant.ts`), and `apollo.192.168.1.7` is not a name anything resolves.
What is needed is a real hostname that happens to point at your Mac, which is what the wildcard DNS
services provide — `192.168.1.7.sslip.io` resolves to `192.168.1.7`, and so does anything under it.

**The mobile side is automatic.** `app.config.ts` finds this machine's LAN address and builds
`<ip>.sslip.io:4000` — asking anyone to paste their current IP into an environment variable on
every `pnpm start` is a step that gets forgotten, and the symptom is an unexplained "No connection"
on the phone with a healthy API sitting right next to it.

**The API side is one line, and it must match**, because the server compares the Host header
against its own base domain. `pnpm start` prints the exact value:

```
📱 mobile will call  http://<hospital>.192.168.1.7.sslip.io:4000
   the API needs     TENANT_BASE_DOMAIN=192.168.1.7.sslip.io  (apps/api/.env)
```

`apollo` then becomes `http://apollo.192.168.1.7.sslip.io:4000`, the phone resolves it to your Mac,
and the server reads `apollo` out of the subdomain exactly as it does in production. Confirm before
reaching for the phone — a tenant-resolution failure and a wifi failure look identical from a
handset:

```bash
curl -s -H 'Host: apollo.192.168.1.7.sslip.io' http://192.168.1.7:4000/api/v1/auth/login \
  -X POST -H 'Content-Type: application/json' -d '{}'
# HMS-VAL-001 → the tenant resolved; the request only lacks credentials. Good.
# HMS-TEN-001 → the host did not match a tenant. The two domains disagree.
```

Three things to know:

- **`app.config.ts` is read when Metro STARTS.** Editing it, or moving to a network with a
  different IP, changes nothing until `pnpm start -c`. Reloading the app in Expo Go is not enough —
  the hospital screen keeps showing the old domain in its hint, which is the quickest way to tell
  the config is stale.
- **It moves the web app too.** `TENANT_BASE_DOMAIN` also drives the dev CORS allowlist
  (`*.<domain>`), so while it is switched, browse to `apollo.192.168.1.7.sslip.io:3000` rather than
  `apollo.localhost:3000`. React Native does not enforce CORS, so the phone is indifferent. Set it
  back to `localhost` when you are done with the device.
- **`sslip.io` is DNS, so it needs a resolver.** On a machine with no internet, force the old
  behaviour with `MEDICORE_DEV_TENANT_DOMAIN=localhost:4000` and use a simulator.

Nothing about this reaches a real build. The LAN address and `MEDICORE_DEV_TENANT_DOMAIN` are read
only for the `development` profile; staging and production are fixed in `app.config.ts`, where
neither an env var nor a network interface can move them.

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
# exposdk:54.0.0  → Expo Go can load it
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
- **Expo Go older than the project's SDK.** This app is on SDK 54 — see the top of this file.

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
- **A green gate does not mean the app opens.** Typecheck, 97 tests and `bundle:check` all passed
  on a build that crashed on the first screen of a fresh install. Nothing in CI renders React, so
  the first launch on a device with no stored hospital is a manual check — clear the app's data
  (Android: App info → Storage → Clear data; Expo Go: delete and re-scan) rather than testing only
  the warm path your phone has been on all day.
- **Never construct a second `ApiClient`.** `src/lib/apiClient.ts` is the only place, and a lint
  rule plus a boundary rule guard the storage equivalents. If the client is missing something, add
  it to `packages/api-client` where `client:check` can see it.
