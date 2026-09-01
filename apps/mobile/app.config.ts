/**
 * Expo app configuration (M0 §17).
 *
 * ── NO HOSPITAL IS BAKED IN ─────────────────────────────────────────────────
 * One binary serves every hospital. The tenant is chosen at runtime and becomes the base URL
 * (M0 §6), so nothing here names a customer. What the profile DOES decide is which *environment*
 * the app may reach — staging or production — because that is a build-time trust decision, not a
 * user preference: a production build must not be pointable at a staging API by anyone holding it.
 *
 * ── runtimeVersion, AND WHY DEVELOPMENT DOES NOT SET IT ─────────────────────
 * `appVersion` policy for anything that can receive an EAS Update, deliberately (M0 §17). An
 * update only reaches binaries with a matching runtimeVersion, so tying it to the app version
 * means a JS update can never land on a binary whose native runtime lacks what the JS expects.
 * A fixed string would widen delivery and the failure mode is "crashes on the one device path
 * that exercises the missing native module" — the class of bug OTA is meant to avoid.
 *
 * **It is omitted in development, because setting it at all makes the project unloadable in
 * Expo Go.** Expo Go runs one native runtime — its own — and identifies it as `exposdk:<version>`.
 * A project advertising any other runtimeVersion is telling every client "you need a matching
 * development build", so Expo Go refuses the manifest. On Android it does so as
 * `java.io.IOException: Failed to download remote update`, which names neither runtimeVersion nor
 * Expo Go, and looks for all the world like a network failure. It cost an afternoon of chasing
 * ports and wifi.
 *
 * Nothing is lost by the omission: EAS Update does not serve development builds, so the field has
 * no meaning there. `preview` and `production` — the two profiles that DO receive updates — set it.
 *
 * ── AND WHAT `app.json` IS FOR, NOW THAT THIS FILE EXISTS ───────────────────
 * Writing. Nothing else. Expo reads `app.json` first and hands it here as `config`, and everything
 * this function names explicitly WINS — so a key set over there is a key that appears to work and
 * does not. It held a stale `plugins: [..., "expo-status-bar"]` on exactly that basis, inert for
 * months. It is `{}` now, kept only because `eas init` needs a static file to record the project
 * id and owner in, and because `...config` and `...config.extra` below are what carry them through.
 */
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import type { ConfigContext, ExpoConfig } from "expo/config";

/** Which API estate this binary is allowed to talk to. Set per EAS profile. */
type Environment = "development" | "staging" | "production";

const ENVIRONMENT = (process.env.EXPO_PUBLIC_ENV ?? "development") as Environment;

/**
 * The domain hospital slugs are resolved against — `apollo` → `https://apollo.<domain>`.
 * The hostname IS the tenant (Doc 04 §5.1), so this is the only tenancy knob a build carries.
 *
 * ── WHY DEVELOPMENT IS THE ONLY OVERRIDABLE ROW ─────────────────────────────
 * `localhost` is a lie on a physical phone: `apollo.localhost` resolves to the PHONE's loopback,
 * so the handset looks for the API on itself and never reaches the Mac. A simulator shares the
 * host's loopback and does not have this problem, which is exactly why it goes unnoticed.
 *
 * The fix cannot be an IP, because the slug has to be a SUBDOMAIN for the server to read a tenant
 * out of it — `apollo.192.168.1.7` is not a resolvable name. `sslip.io` answers any
 * `<anything>.<ip>.sslip.io` with that IP, so `apollo.192.168.1.7.sslip.io` reaches this Mac while
 * the URL stays the host, exactly as M0 §6 requires.
 *
 * It is DERIVED, not typed. Asking a developer to paste their current IP into an environment
 * variable on every `pnpm start` is a step that will be forgotten — it was, twice, and the symptom
 * is an unexplained "No connection" on the phone with a healthy API sitting right there. The
 * address is discoverable, so it is discovered.
 *
 * Staging and production are NOT derived and NOT overridable. Which estate a signed build may
 * reach is the trust decision in the header above, and neither an env var nor a network interface
 * is allowed to move it.
 */

/** This machine's LAN address — what a phone on the same wifi can actually route to. */
function lanAddress(): string | undefined {
  const interfaces = networkInterfaces();
  // en0 is Wi-Fi on macOS. Checked first so a VPN tunnel or a virtual adapter cannot win the race
  // and hand out an address the phone has no route to.
  const ordered = [
    ...(interfaces.en0 ?? []),
    ...Object.entries(interfaces)
      .filter(([name]) => name !== "en0")
      .flatMap(([, addresses]) => addresses ?? []),
  ];
  return ordered.find((a) => a.family === "IPv4" && !a.internal)?.address;
}

function developmentDomain(): string {
  // The escape hatch: force `localhost:4000` on a machine with no internet (sslip.io is DNS, so it
  // needs a resolver), or point at a colleague's API.
  const override = process.env.MEDICORE_DEV_TENANT_DOMAIN;
  if (override) return override;

  const lan = lanAddress();
  return lan ? `${lan}.sslip.io:4000` : "localhost:4000";
}

const TENANT_DOMAIN: Record<Environment, string> = {
  development: developmentDomain(),
  staging: "staging.paperlesstech.in",
  production: "paperlesstech.in",
};

/**
 * The EAS project this binary belongs to — the ONE thing without which no push token exists.
 *
 * ── IT IS READ FROM TWO PLACES, AND THAT IS DELIBERATE ──────────────────────
 * `eas init` records the id at `extra.eas.projectId`. With a DYNAMIC config — this file — it
 * CANNOT write here, so it writes `app.json` and prints a note that is easy to miss. The id is
 * therefore accepted from either: `app.json` (which arrives as `config.extra`) or `EAS_PROJECT_ID`
 * in the environment, environment first. Neither is a secret — a project id names an Expo project,
 * it authorises nothing — which is why it may sit in a committed file.
 *
 * ── THE DEFECT THIS FUNCTION EXISTS TO CLOSE ────────────────────────────────
 * `extra` below used to be written FRESH, with no `...config.extra`. Anything `eas init` put in
 * app.json was silently discarded on its way through this function: the repository would show a
 * linked project, `expo config` would show none, and `getExpoPushTokenAsync` would go on returning
 * undefined with nothing logged anywhere. The same shape of bug as the colon in the BullMQ job id
 * — a step that reports success and does nothing — and it would have wasted the first device
 * session outright.
 */
function easProjectId(configured: unknown): string | undefined {
  const fromAppJson = (configured as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  return process.env.EAS_PROJECT_ID ?? fromAppJson;
}

/**
 * Firebase's client config. Android cannot obtain an FCM token without it, and Expo's push service
 * cannot reach the handset without the matching V1 service-account key held in EAS credentials.
 *
 * It is NEVER committed — `.gitignore` files it with the signing material — so the reference is
 * conditional on the file being there. A checkout without it still installs, still type-checks,
 * still exports a bundle and still runs on a simulator; only a real Android push build needs it.
 * Naming a missing path unconditionally would break `expo prebuild` for everyone not doing push
 * work today, which is the wrong trade for a file three people will ever hold.
 */
const GOOGLE_SERVICES = process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json";

/**
 * Both halves have to agree — the server matches the Host header against its OWN base domain, and
 * a mismatch surfaces as `HMS-TEN-001 Organization not found`, which reads like a bad hospital code
 * rather than a configuration error. Printing the required value costs one line and removes the
 * guesswork the other direction.
 */
if (ENVIRONMENT === "development") {
  const domain = TENANT_DOMAIN.development;
  console.log(
    `\n  📱 mobile will call  http://<hospital>.${domain}` +
      `\n     the API needs     TENANT_BASE_DOMAIN=${domain.replace(/:\d+$/, "")}  (apps/api/.env)\n`,
  );
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const projectId = easProjectId(config.extra);

  /**
   * Said out loud, because the alternative is a silent shrug on a phone.
   *
   * `platform/pushNotifications.ts` returns `undefined` for four ordinary reasons and reports
   * none of them — correctly, since none is a problem to show a doctor. That is the right
   * behaviour in the app and the wrong one on the bench: a tester who sees no notification cannot
   * tell "no EAS project" from "permission declined". This line settles the first of the four
   * before the app has even started.
   */
  if (ENVIRONMENT === "development") {
    console.log(
      projectId
        ? `  🔔 push: EAS project ${projectId} — a development build can mint a token\n`
        : "  🔕 push: no EAS project id — `eas init`, or set EAS_PROJECT_ID. " +
            "No token will be minted and no device will register.\n",
    );
  }

  return {
    ...config,
    name: ENVIRONMENT === "production" ? "MediCore" : `MediCore (${ENVIRONMENT})`,
    slug: "medicore-staff",
    scheme: "medicore",
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    // See the header: set for the profiles that receive EAS Updates, omitted for Expo Go.
    ...(ENVIRONMENT === "development" ? {} : { runtimeVersion: { policy: "appVersion" as const } }),

    ios: {
      supportsTablet: true,
      bundleIdentifier:
        ENVIRONMENT === "production"
          ? "in.paperlesstech.medicore"
          : `in.paperlesstech.medicore.${ENVIRONMENT}`,
    },
    android: {
      package:
        ENVIRONMENT === "production"
          ? "in.paperlesstech.medicore"
          : `in.paperlesstech.medicore.${ENVIRONMENT}`,
      // Present only on a machine doing Android push work — see GOOGLE_SERVICES above.
      ...(existsSync(GOOGLE_SERVICES) ? { googleServicesFile: GOOGLE_SERVICES } : {}),
    },

    plugins: [
      "expo-router",
      "expo-secure-store",
      /**
       * ── WHY THE PLUGIN, WHEN THE MODULE IS ALREADY AUTOLINKED ─────────────
       * `expo-notifications` delivers LOCAL notifications without any of this. Two things it does
       * that a REMOTE push build cannot do without:
       *
       *   `mode`            writes the iOS `aps-environment` entitlement. A binary signed for the
       *                     production APNs estate cannot receive a token minted against the
       *                     sandbox, and the mismatch does not error anywhere — Expo accepts the
       *                     push, returns an `ok` ticket, and the phone stays silent. It is the
       *                     single most confusing way for iOS push to "work" and not arrive, and
       *                     it is why this is derived from the build profile rather than left at
       *                     its default.
       *   `defaultChannel`  names the Android channel an FCM message carrying none of its own
       *                     lands in. It must be `PUSH_CHANNEL.routine` from `@medicore/types` —
       *                     the DEFAULT-importance one — so an unclassified message waits quietly
       *                     instead of interrupting a ward round. Naming a channel the app does
       *                     not create is worse than either: Android discards the notification
       *                     outright, with an `ok` ticket from Expo and nothing in any log.
       *
       *                     Spelled as a literal rather than imported. This file is evaluated by
       *                     Expo's config loader before anything in the workspace is built, so an
       *                     import of `@medicore/types` would make `expo start` depend on a
       *                     prior `pnpm build`. `notificationChannels.test.ts` pins the pair
       *                     instead.
       */
      [
        "expo-notifications",
        {
          mode: ENVIRONMENT === "production" ? "production" : "development",
          defaultChannel: "default",
        },
      ],
    ],

    experiments: { typedRoutes: true },

    extra: {
      /**
       * FIRST, and it matters: this carries whatever `eas init` wrote to app.json — the project
       * id, and `owner` alongside it. Writing this object without the spread is what silently
       * unlinked the EAS project before (see `easProjectId`).
       */
      ...config.extra,
      environment: ENVIRONMENT,
      tenantDomain: TENANT_DOMAIN[ENVIRONMENT],
      /**
       * Plain `http` for local development only. A staging or production build uses HTTPS with no
       * way to opt out — see `resolveBaseUrl`, which refuses to build an insecure URL outside dev.
       */
      insecureTransportAllowed: ENVIRONMENT === "development",
      // Absent rather than `{ eas: { projectId: undefined } }`: `getExpoPushTokenAsync` reads the
      // shape, and an explicit undefined is a different thing to debug than a missing key.
      ...(projectId ? { eas: { ...(config.extra?.eas ?? {}), projectId } } : {}),
    },
  };
};
