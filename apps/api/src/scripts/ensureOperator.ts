/**
 * Make the console operator login WORK — create it, or reset its password (dev only).
 *
 *     pnpm seed:operator                          # ops@paperlesstech.in / 123456
 *     pnpm seed:operator --email you@x.in --password 'secret'
 *
 * Unlike the `operator` bootstrap (which refuses once any operator exists), this always leaves you
 * with a working login: if the email exists it just resets the password, otherwise it creates the
 * operator. That is why it is DEV ONLY — it refuses to run when NODE_ENV is production, the same
 * guard `seed:demo` runs under. It is the "I can't get into the console" escape hatch.
 */
import { createLogger } from "@medicore/logger";
import { env } from "../config/env.js";
import { closeMaster } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";
import { closeAllTenantConnections } from "../core/db/connectionManager.js";
import { upsertDevOperator } from "../modules/platform/index.js";

const logger = createLogger({ service: "ensure-operator" });

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    throw new Error("seed:operator resets a super-admin password — never in production");
  }

  // Sensible defaults so `pnpm seed:operator` with NO arguments just works.
  const email = arg("--email") ?? "ops@paperlesstech.in";
  const name = arg("--name") ?? "Platform Operator";
  const password = arg("--password") ?? "123456";

  const result = await upsertDevOperator({ email, name, password });
  logger.info({ email: result.email, created: result.created }, "console operator ready");

  process.stdout.write(
    "\n" +
      `  ┌─ Console operator ${result.created ? "CREATED" : "PASSWORD RESET"} ──────────────┐\n` +
      "     URL       http://localhost:3001\n" +
      `     Email     ${result.email}\n` +
      `     Password  ${password}\n` +
      "     Role      SUPER_ADMIN\n" +
      "  └───────────────────────────────────────────────────────┘\n\n",
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "seed:operator failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
  });
