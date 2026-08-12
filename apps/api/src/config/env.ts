/**
 * Zod-validated environment (Doc 04 §2.3: fail fast at boot;
 * Doc 09 §13: process.env access ONLY in this module).
 */
import { z } from "@medicore/validation";
import { activeProfile, applyProductionInvariants, PROFILE_DEFAULTS } from "./profiles.js";
import { isValidTimeZone } from "../core/time/zone.js";

/**
 * A boolean from an environment variable. Never use `z.coerce.boolean()` for this.
 *
 * Environment variables are always STRINGS, and `Boolean("false")` is `true` —
 * every non-empty string is truthy. `z.coerce.boolean()` therefore reads
 * `PASSWORD_REQUIRE_COMPLEXITY=false` as **true**, silently doing the exact
 * opposite of what the config file says. It cost us a bewildered ten minutes
 * here; in production it would be a security control that reports itself as ON
 * while being OFF, or vice versa.
 *
 * Accepts the spellings people actually write, and REJECTS anything else rather
 * than guessing — a typo'd flag must fail at boot, not resolve to a coin flip.
 */
const envBool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === "") return defaultValue;
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be true/false (got "${value}")`,
      });
      return z.NEVER;
    });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.string().default("info"),

  /**
   * Which network interface to listen on.
   *
   * Defaults to `127.0.0.1` in production: the API is meant to sit BEHIND the
   * gateway (Nginx/Traefik), so it should be unreachable from the network even
   * if a firewall rule is wrong or a security group is too generous. Binding to
   * 0.0.0.0 in production is how an internal service ends up on the public
   * internet by accident.
   *
   * Containers must override it — inside Docker, `127.0.0.1` is reachable only
   * from within the container itself, so compose sets `API_BIND=0.0.0.0` and
   * Docker's own networking provides the isolation instead.
   */
  API_BIND: z.string().optional(),

  /**
   * Shared MongoDB cluster URI. The master DB and all co-located tenant DBs are
   * databases ON this cluster (selected via `useDb`). A tenant promoted to a
   * dedicated server overrides it with its own `dbUri` in the registry
   * (Doc 03 §1.1/§1.5) — no code change.
   * Optional so the service still boots for health-only mode; tenancy-dependent
   * routes fail loudly with HMS-TEN-004 when absent.
   */
  MONGO_URI: z.string().url().optional(),
  /**
   * Cross-cluster safety net (dev). The replica-set member the master connection
   * MUST land on, e.g. `localhost:37018`. If set and the server we actually reach
   * advertises a different member, the process refuses to start.
   *
   * WHY THIS EXISTS: replica sets are conventionally all named `rs0`, so a driver
   * cannot tell it has crossed into ANOTHER project's Mongo — an SSH tunnel or a
   * second container on the same host port is enough to silently redirect us onto
   * a foreign cluster. This project sidesteps that by owning a dedicated port
   * (37018) and naming its set `hms0`, and this check is the backstop (see
   * infra/docker/LOCAL_PORTS.md). A no-op unless set, so production — which reaches
   * Mongo through real hostnames — is never affected.
   */
  MONGO_EXPECT_MEMBER: z.string().optional(),
  /** Master database — platform data ONLY, never PHI (Doc 03 §1.1). */
  MONGO_MASTER_DB: z.string().default("paperlesstech_master"),
  /** Tenant database naming: `hms_<slug>` (Doc 03 §1.1). */
  TENANT_DB_PREFIX: z.string().default("hms_"),
  /**
   * Subdomain tenancy: `<slug>.<TENANT_BASE_DOMAIN>` (Doc 04 §2.2.1).
   *
   * **Defaults to `localhost`, and that default is a safety property, not a
   * convenience.** An unconfigured process must behave like a local one.
   *
   * The previous default was the real production domain, which meant a developer
   * who forgot a `.env` got a system quietly configured for production: CORS
   * would reflect `*.paperlesstech.in` origins, provisioning would print
   * production URLs, and — because `*.paperlesstech.in` has wildcard DNS pointing
   * at the live server — a browser following those instructions leaves the
   * machine entirely. A default should fail safe, and "safe" here means "local".
   *
   * Production sets this explicitly. Naming your own domain is one line of
   * config; discovering that dev was silently aimed at production is an incident.
   */
  TENANT_BASE_DOMAIN: z.string().default("localhost"),

  REDIS_URL: z.string().url().optional(),
  /** Registry cache TTL in seconds — CACHE_STRATEGY: `tenant:{slug}` 5 min. */
  TENANT_CACHE_TTL_SECONDS: z.coerce.number().int().default(300),
  /**
   * How long we remember that a host does NOT exist (negative caching).
   *
   * Without this, every request to an unknown host is an uncached query against
   * the MASTER registry — the one database that routes every hospital on the
   * platform. We publish wildcard DNS (`*.paperlesstech.in`), so anyone can spray
   * `a1.…`, `a2.…` and turn that into a denial of service that takes down routing
   * for every customer at once. Remembering a miss makes the flood free.
   *
   * SHORT on purpose (30s, not the 5 minutes we cache a hit). A hospital that was
   * probed before it was provisioned must not 404 for five minutes afterwards —
   * and provisioning busts the key anyway (tenant.repository.create), so this TTL
   * is only the belt to that braces.
   */
  TENANT_MISS_CACHE_TTL_SECONDS: z.coerce.number().int().default(30),

  /**
   * Per-tenant licence (tenure) defaults — ADR-0016. A licence is a validity window
   * (`validFrom → expiresAt`) plus a grace window (`graceDays` after expiry). It is
   * INDEPENDENT of the tenant status (operator suspend) and of the edition/plan:
   * the edition says what a hospital may use, the licence says until when.
   */
  /** A freshly provisioned hospital gets this many trial days when no expiry is set. */
  LICENSE_DEFAULT_TRIAL_DAYS: z.coerce.number().int().min(1).default(14),
  /** Days after `expiresAt` a hospital still runs (banner shown, access not yet cut). */
  LICENSE_DEFAULT_GRACE_DAYS: z.coerce.number().int().min(0).default(7),
  /** Within this many days of expiry, the tenant UI shows the "expires in N days" banner. */
  LICENSE_WARN_DAYS: z.coerce.number().int().min(1).default(10),

  /** Connection Manager guardrails (Doc 04 §2.2.1; PROJECT_MEMORY assumption A3). */
  TENANT_MAX_CONNECTIONS: z.coerce.number().int().default(200),
  TENANT_CONNECTION_IDLE_MS: z.coerce.number().int().default(600_000),

  /* ── Identity & Authentication (ADR-0009) ──────────────────────────────── */

  /**
   * Access-token signing secret (HS256). Required — there is deliberately no
   * default: a fallback secret is the classic way a dev key reaches production.
   * Generate with `openssl rand -base64 48`.
   */
  API_JWT_SECRET: z.string().min(32, "API_JWT_SECRET must be at least 32 characters"),
  API_JWT_ISSUER: z.string().default("paperlesstech"),
  /** Access-token life. Short by design: revocation latency is bounded by it (ADR-0009). */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().max(3600).default(900),
  /** Refresh-token family life (rotating, reuse-detected). */
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  /** Life of the interim token issued between password success and MFA success. */
  MFA_CHALLENGE_TTL_SECONDS: z.coerce.number().int().default(300),

  /**
   * Field-encryption key for secrets at rest (TOTP seeds today; per-tenant
   * integration credentials later — Constitution §11). 32 bytes, base64 or hex.
   * Generate with `openssl rand -base64 32`.
   */
  API_ENCRYPTION_KEY: z.string().min(32, "API_ENCRYPTION_KEY must be a 32-byte base64/hex key"),

  /**
   * Password policy (Doc 09 §20; NABH/HIPAA account-security controls).
   *
   * The DEFAULTS are the production policy: 12 characters with mixed case, a
   * digit and a symbol. Local development may relax both (see the two guards in
   * `loadEnv`) so a developer can type `123456` all day — a strong password on a
   * throwaway laptop database buys nothing and costs a hundred keystrokes an hour.
   *
   * The floor of 4 exists only so dev can go low; production cannot use it.
   */
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(4).default(12),
  /** Mixed case + digit + symbol. Forced ON in production, whatever the config says. */
  PASSWORD_REQUIRE_COMPLEXITY: envBool(true),
  PASSWORD_HISTORY_SIZE: z.coerce.number().int().default(5),
  /**
   * The password every generated DEV account gets (staff, hospital admins, the
   * operator bootstrap). Ignored entirely when NODE_ENV=production, where
   * `generatePassword` mints a strong random one instead — and where the forced
   * production policy would reject this anyway. See core/crypto/password.ts.
   */
  DEV_DEFAULT_PASSWORD: z.string().default("123456"),
  /** Brute-force lockout. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().default(15),

  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),

  /**
   * Outbox relay (ADR-0007, Doc 03 §5.2). Every API pod runs the loop; a Redis
   * lock elects one leader, so these knobs describe the FLEET, not the pod.
   *
   * Turn the relay off only where something else is relaying (a dedicated pod) or
   * where nothing should be delivered at all (a restore drill, a forensic copy of
   * production). An API with the relay off still *records* events — they queue up
   * durably in the outbox and drain when a relay comes back.
   */
  OUTBOX_RELAY_ENABLED: envBool(true),
  OUTBOX_POLL_MS: z.coerce.number().int().min(200).default(2_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  /** After this many failed dispatches an event moves to `failed` — the DLQ. */
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),

  /* ── Notifications (Doc 02 A6) ─────────────────────────────────────────── */

  /**
   * Whether this pod consumes the notifications queue at all.
   *
   * Off means events still queue durably — nothing is lost, delivery is merely
   * deferred until a consumer returns. That is the state you want during a
   * restore drill or on a forensic copy of production, where the LAST thing you
   * want is a thousand patients receiving yesterday's appointment reminders again.
   */
  NOTIFY_CONSUMER_ENABLED: envBool(true),

  /**
   * The outbound kill switch, per channel (FEATURE_ROLLOUT: standing `ops.*`
   * switches for outbound notifications). Turning email off does not stop
   * notifications being RECORDED — they land in the ledger as `suppressed`, so
   * the hospital can see exactly what would have gone out and to whom.
   *
   * This is the switch you reach for at 3am when a template bug is mailing the
   * wrong people. It is separate from NOTIFY_CONSUMER_ENABLED on purpose: one
   * stops delivery, the other stops the whole pipeline.
   */
  NOTIFY_EMAIL_ENABLED: envBool(true),

  /**
   * SMTP. Unset host = no email transport: the service records every message as
   * `unreachable` rather than crashing, so a dev machine with no mail server is a
   * degraded pipeline, never a broken one.
   *
   * Dev points at Mailhog (infra/docker: SMTP 1025, inbox UI http://localhost:8025).
   */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: envBool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default("MediCore <no-reply@paperlesstech.in>"),

  /**
   * The timezone a patient-facing time is rendered in.
   *
   * A reminder that names the wrong hour is worse than no reminder: the patient
   * arrives five and a half hours late and blames the hospital. Timestamps are
   * stored in UTC (they always should be) and MUST be rendered in the timezone the
   * patient actually lives in.
   *
   * This is a platform-wide default because branch-level timezones are not modelled
   * yet (B1–B3). It is the ONE place that assumption is written down, so when a
   * hospital group spans Kochi and Dubai, this is the line that becomes a lookup —
   * not a search through every template.
   */
  DEFAULT_TIMEZONE: z
    .string()
    .default("Asia/Kolkata")
    /**
     * Validated at BOOT, not at first use. This zone is the fallback every bed-day falls back
     * TO, so a typo here does not fail one branch — it fails the substitute the others rely on.
     * The env loader is already fail-fast by design (Doc 04 §2.3); this belongs with it.
     */
    .refine(isValidTimeZone, {
      message: "DEFAULT_TIMEZONE must be an IANA zone such as Asia/Kolkata",
    }),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Resolves the effective configuration. Precedence, lowest to highest:
 *
 *   1. schema default (this file)   2. profile default (profiles.ts)
 *   3. environment variable          4. production invariant (profiles.ts)
 *
 * Step 4 runs LAST and cannot be overridden — see `applyProductionInvariants`.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const profile = activeProfile(source.NODE_ENV ?? "development");

  // Profile defaults fill only what the environment did NOT set: a deployment
  // always outranks a default, and an empty string counts as "set" (that is how
  // `API_BIND=""` asks for a dual-stack bind).
  const merged: Record<string, string | undefined> = { ...source };
  for (const [key, value] of Object.entries(PROFILE_DEFAULTS[profile])) {
    if (merged[key] === undefined) merged[key] = value;
  }

  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    // Boot-time failure must be loud and precise (fail fast).
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  const config: Record<string, unknown> = parsed.data;

  if (profile === "production") {
    for (const violation of applyProductionInvariants(config)) {
      // Not a warning. A production deployment that tried to weaken a security
      // property is a defect in someone's pipeline, and it must be impossible to
      // scroll past.
      console.error(
        `[SECURITY] ${violation.key}=${violation.attempted} is not permitted in production — ` +
          `using ${violation.enforced} instead (${violation.why}). Fix the configuration.`,
      );
    }
  }

  return config as Env;
}

/**
 * A human-readable summary of what this process actually decided — logged at
 * boot. Never prints a secret; a key's PRESENCE is reported, never its value.
 *
 * This exists because every config bug we have hit was invisible: the process
 * looked healthy and was quietly pointed at the wrong thing. One line at startup
 * that says "profile=local, hosts=*.localhost, bind=dual-stack" turns an hour of
 * confused debugging into a glance.
 */
export function describeConfig(): Record<string, string> {
  return {
    profile: activeProfile(env.NODE_ENV),
    nodeEnv: env.NODE_ENV,
    hospitalHosts: `*.${env.TENANT_BASE_DOMAIN}`,
    apiBind: env.API_BIND ? env.API_BIND : ":: (dual-stack)",
    passwordPolicy: env.PASSWORD_REQUIRE_COMPLEXITY
      ? `${String(env.PASSWORD_MIN_LENGTH)}+ chars, mixed case + digit + symbol`
      : `${String(env.PASSWORD_MIN_LENGTH)}+ chars, NO complexity (development only)`,
    outboxRelay: env.OUTBOX_RELAY_ENABLED ? "on" : "off",
    // "consuming, but mail goes nowhere" is a state that looks healthy and is not.
    // It is worth one word at boot rather than a support ticket a week later.
    notifications: !env.NOTIFY_CONSUMER_ENABLED
      ? "consumer off"
      : !env.NOTIFY_EMAIL_ENABLED
        ? "on (email suppressed)"
        : env.SMTP_HOST
          ? `on (smtp ${env.SMTP_HOST}:${String(env.SMTP_PORT)})`
          : "on (no SMTP host — email unreachable)",
  };
}

export const env = loadEnv();

/** Tenant DB name from slug — the single place this convention is encoded. */
export function tenantDatabaseName(slug: string): string {
  return `${env.TENANT_DB_PREFIX}${slug}`;
}

/**
 * The interface to listen on.
 *
 * `undefined` means "let Node choose", which on a dual-stack host means `::` —
 * IPv6 **and** IPv4-mapped addresses. That is the correct default for local dev,
 * and getting it wrong is not theoretical:
 *
 *   `demo.localhost` resolves to `::1` BEFORE `127.0.0.1` on macOS. Binding
 *   `0.0.0.0` listens on IPv4 only, so the browser's request to `[::1]:4000` was
 *   refused while `curl` silently fell back to IPv4 and reported success. The API
 *   looked perfectly healthy from the terminal and was unreachable from the
 *   browser — the worst kind of bug, because every tool you would reach for to
 *   diagnose it says everything is fine.
 *
 * Production still defaults to loopback: the API is reachable only through the
 * gateway, so a misconfigured firewall cannot expose Express to the internet.
 * Containers set `API_BIND=0.0.0.0` explicitly (container networks are IPv4).
 */
export function bindAddress(): string | undefined {
  if (env.API_BIND) return env.API_BIND;
  return env.NODE_ENV === "production" ? "127.0.0.1" : undefined;
}
