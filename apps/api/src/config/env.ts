/**
 * Zod-validated environment (Doc 04 §2.3: fail fast at boot;
 * Doc 09 §13: process.env access ONLY in this module).
 */
import { z } from "@medicore/validation";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.string().default("info"),
  /** Optional in Sprint 0 — readiness reports "skipped" when absent. P1 makes these required. */
  MONGO_URI: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
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
