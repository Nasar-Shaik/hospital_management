# @medicore/mobile — Staff Mobile App (M1 foundation)

The React Native staff application. **M1 is the foundation only**: sign in, stay signed in, know
who you are, know which site you are at, and fail comprehensibly. No clinical or financial workflow
ships here — those are M2 onward. See
[MOBILE_M0_ARCHITECTURE.md](../../AI_Workflow/docs/MOBILE_M0_ARCHITECTURE.md) for the approved
architecture; this README covers only what is specific to running and extending the code.

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

### Why the dev server runs on 8082, not 8081

**Deliberate, and it is not arbitrary.** 8081 is the React Native default, so every Expo project on
a machine wants it — and this team runs a second one (the School ERP) alongside this app. When two
processes contend for it the failure is genuinely nasty rather than obvious:

- The first process takes IPv4 `*:8081`. Metro starts anyway and binds **IPv6** `*:8081`, printing
  no warning that it did not get the port it wanted.
- The QR code encodes `exp://<your-ipv4>:8081`, so the phone connects to the **other project's**
  server, asks it for an Expo manifest, and gets whatever that service returns.
- Expo Go reports `java.io.IOException: Failed to download remote update` — which names neither
  the port, the other process, nor the fact that the two apps collided.

It cost an afternoon once. Two projects, two ports; HMS mobile owns 8082. (HMS API is 4000, web is
3000.) If you ever need to check by hand:

```bash
lsof -nP -iTCP:8081 -sTCP:LISTEN     # who else is here
curl http://<your-ip>:8082/          # should be Expo, not another app's JSON
```

### Other reasons Expo Go fails to connect

1. **Phone and Mac are not on the same network**, or the wifi has client isolation. Test by opening
   `http://<your-ip>:8082` in the phone's browser. `pnpm start:tunnel` works around it.
2. **A stale Metro cache** after changing `app.config.ts`, `metro.config.js` or import paths — the
   terminal shows the real error, and `start -c` clears it.
3. **Expo Go's SDK is older than the project's.** This app is on SDK 57; update Expo Go from the
   store, or use a development build.

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
