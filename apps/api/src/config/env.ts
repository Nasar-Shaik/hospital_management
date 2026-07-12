/**
 * Zod-validated environment (Doc 04 §2.3: fail fast at boot;
 * Doc 09 §13: process.env access ONLY in this module).
 */
import { z } from "@medicore/validation";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.string().default("info"),

  /**
   * Shared MongoDB cluster URI. The master DB and all co-located tenant DBs are
   * databases ON this cluster (selected via `useDb`). A tenant promoted to a
   * dedicated server overrides it with its own `dbUri` in the registry
   * (Doc 03 §1.1/§1.5) — no code change.
   * Optional so the service still boots for health-only mode; tenancy-dependent
   * routes fail loudly with HMS-TEN-004 when absent.
   */
  MONGO_URI: z.string().url().optional(),
  /** Master database — platform data ONLY, never PHI (Doc 03 §1.1). */
  MONGO_MASTER_DB: z.string().default("paperlesstech_master"),
  /** Tenant database naming: `hms_<slug>` (Doc 03 §1.1). */
  TENANT_DB_PREFIX: z.string().default("hms_"),
  /** Subdomain tenancy: `<slug>.paperlesstech.in` (Doc 04 §2.2.1). */
  TENANT_BASE_DOMAIN: z.string().default("paperlesstech.in"),

  REDIS_URL: z.string().url().optional(),
  /** Registry cache TTL in seconds — CACHE_STRATEGY: `tenant:{slug}` 5 min. */
  TENANT_CACHE_TTL_SECONDS: z.coerce.number().int().default(300),

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

  /** Password policy (Doc 09 §20; NABH/HIPAA account-security controls). */
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),
  PASSWORD_HISTORY_SIZE: z.coerce.number().int().default(5),
  /** Brute-force lockout. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().default(15),

  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3001"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Boot-time failure must be loud and precise (fail fast).
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

/** Tenant DB name from slug — the single place this convention is encoded. */
export function tenantDatabaseName(slug: string): string {
  return `${env.TENANT_DB_PREFIX}${slug}`;
}
