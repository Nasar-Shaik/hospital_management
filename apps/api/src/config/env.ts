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
