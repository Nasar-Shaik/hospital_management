/**
 * Build-time configuration, read once from `app.config.ts` → `extra`.
 *
 * Typed and validated at module load rather than read ad hoc: a missing `tenantDomain` would
 * otherwise produce `https://apollo.undefined` at the first login attempt, which reads as a
 * network error and sends everyone looking in the wrong place.
 */
import Constants from "expo-constants";

export interface AppConfig {
  environment: "development" | "staging" | "production";
  tenantDomain: string;
  insecureTransportAllowed: boolean;
}

function read(): AppConfig {
  const extra = (Constants.expoConfig?.extra ?? {}) as Partial<AppConfig>;
  if (!extra.tenantDomain) {
    throw new Error(
      "app.config.ts did not provide extra.tenantDomain — the build is misconfigured",
    );
  }
  return {
    environment: extra.environment ?? "development",
    tenantDomain: extra.tenantDomain,
    insecureTransportAllowed: extra.insecureTransportAllowed ?? false,
  };
}

export const appConfig: AppConfig = read();

/** Shown on the About screen and attached to every log line — see M0 §17 on version reporting. */
export const appVersion: string = Constants.expoConfig?.version ?? "0.0.0";
