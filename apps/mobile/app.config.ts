/**
 * Expo app configuration (M0 §17).
 *
 * ── NO HOSPITAL IS BAKED IN ─────────────────────────────────────────────────
 * One binary serves every hospital. The tenant is chosen at runtime and becomes the base URL
 * (M0 §6), so nothing here names a customer. What the profile DOES decide is which *environment*
 * the app may reach — staging or production — because that is a build-time trust decision, not a
 * user preference: a production build must not be pointable at a staging API by anyone holding it.
 *
 * ── runtimeVersion ──────────────────────────────────────────────────────────
 * `appVersion` policy, deliberately (M0 §17). An EAS Update only reaches binaries with a matching
 * runtimeVersion, so tying it to the app version means a JS update can never land on a binary whose
 * native runtime does not have what the JS expects. Changing this to a fixed string would make OTA
 * delivery wider and the failure mode "crashes on the one device path that exercises the missing
 * native module" — which is exactly the class of bug OTA is supposed to avoid.
 */
import type { ConfigContext, ExpoConfig } from "expo/config";

/** Which API estate this binary is allowed to talk to. Set per EAS profile. */
type Environment = "development" | "staging" | "production";

const ENVIRONMENT = (process.env.EXPO_PUBLIC_ENV ?? "development") as Environment;

/**
 * The domain hospital slugs are resolved against — `apollo` → `https://apollo.<domain>`.
 * The hostname IS the tenant (Doc 04 §5.1), so this is the only tenancy knob a build carries.
 */
const TENANT_DOMAIN: Record<Environment, string> = {
  development: "localhost:4000",
  staging: "staging.paperlesstech.in",
  production: "paperlesstech.in",
};

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: ENVIRONMENT === "production" ? "MediCore" : `MediCore (${ENVIRONMENT})`,
  slug: "medicore-staff",
  scheme: "medicore",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  runtimeVersion: { policy: "appVersion" },

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
