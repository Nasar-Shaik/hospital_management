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
 */
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

export default ({ config }: ConfigContext): ExpoConfig => ({
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
  },

  plugins: ["expo-router", "expo-secure-store"],

  experiments: { typedRoutes: true },

  extra: {
    environment: ENVIRONMENT,
    tenantDomain: TENANT_DOMAIN[ENVIRONMENT],
    /**
     * Plain `http` for local development only. A staging or production build uses HTTPS with no
     * way to opt out — see `resolveBaseUrl`, which refuses to build an insecure URL outside dev.
     */
    insecureTransportAllowed: ENVIRONMENT === "development",
  },
});
