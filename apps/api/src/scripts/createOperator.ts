/**
 * Bootstrap the FIRST platform operator (Doc 02 A1).
 *
 *   pnpm --filter @medicore/api operator -- --email you@paperlesstech.in --name "Nasar" --password '...'
 *
 * ── THE CHICKEN AND THE EGG ──────────────────────────────────────────────────
 * Operators are created from the console. The console requires an operator to log
 * in. So the first one has to come from somewhere outside the system, and that
 * somewhere is a command run by whoever already has the database — which is the
 * honest trust boundary: if you can run this, you already own the platform.
 *
 * It REFUSES to run once any operator exists. Not a convenience check — it is the
 * whole security property. Without it, this script would be a permanent,
 * unauthenticated back door that mints super-admins on a live platform, and its
 * mere presence in the repository would be a vulnerability. Further operators are
 * created from the console, by an operator, with an audit entry naming them.
 */
import { createLogger } from "@medicore/logger";
import { closeMaster } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";
import { closeAllTenantConnections } from "../core/db/connectionManager.js";
import { checkPasswordPolicy, generatePassword } from "../core/crypto/password.js";
import { bootstrapFirstOperator } from "../modules/platform/index.js";

const logger = createLogger({ service: "operator-cli" });

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg("--email");
  const name = arg("--name") ?? "Platform Administrator";
  const password = arg("--password") ?? generatePassword();

  if (!email) {
    console.error(
      'Usage: operator --email you@example.com [--name "Your Name"] [--password "..."]',
    );
    process.exit(1);
  }

  const failures = checkPasswordPolicy(password);
  if (failures.length > 0) {
    console.error(`Password rejected: ${failures.join("; ")}`);
    process.exit(1);
  }

  const result = await bootstrapFirstOperator({ email, name, password });

  logger.info({ email: result.email, role: "SUPER_ADMIN" }, "first operator created");

  // On stdout, never through the logger: logs are shipped, indexed and retained,
  // and a credential must not become a log record.
  process.stdout.write(
    "\n" +
      "  ┌─ Operator console credentials (shown once) ──────────────┐\n" +
      `     URL       http://admin.localhost:3001\n` +
      `     Email     ${result.email}\n` +
      `     Password  ${password}\n` +
      "     Role      SUPER_ADMIN\n" +
      "  └───────────────────────────────────────────────────────────┘\n\n",
  );
}

main()
  .catch((err: unknown) => {
    const details = (err as { details?: { hint?: string } }).details;
    if (details?.hint) {
      logger.error({ hint: details.hint }, "refused");
    } else {
      logger.error({ err }, "could not create the first operator");
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
  });
