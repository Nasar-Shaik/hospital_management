/**
 * Licence-state CLI — puts a hospital into a named licence state for manual validation (ADR-0016).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Six rows of the manual validation runbook (§18, LIC-01…LIC-06) need a hospital that is EXPIRING,
 * in GRACE, or EXPIRED. None of those states can be reached by using the product: they are a
 * function of wall-clock time against `expiresAt` and `graceUntil`, so somebody has to set the
 * dates. The runbook said to do it by hand in the operator console with `extendDays: -1`, and that
 * call cannot succeed — `extendDays` is `min(1)` in `hospitalLicenseSchema`, so it is a 400. The
 * instruction had never been run.
 *
 * Doing the arithmetic by hand is also how the wrong hospital gets expired. Every other section of
 * the runbook depends on the validation tenant still working, and an operator computing "now minus
 * a day, plus seven days of grace" at the end of a long session is one typo away from blocking the
 * campaign they are in the middle of.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It invents no licensing model. Every state is expressed in the fields `setLicense` already
 * accepts, resolved by `applyLicensePatch`, and read back through `effectiveLicenseState` — the
 * same function the request gate and the console use, so a state this prints is a state the server
 * agrees with. This is a fixture tool, not a second implementation.
 *
 *   pnpm seed:licence -- --slug licence-lab --state expiring
 *   pnpm seed:licence -- --slug licence-lab --state grace
 *   pnpm seed:licence -- --slug licence-lab --state expired
 *   pnpm seed:licence -- --slug licence-lab --state active     # perpetual: clears the expiry
 *   pnpm seed:licence -- --slug licence-lab --show
 */
import { createLogger } from "@medicore/logger";
import { closeAllTenantConnections } from "../core/db/connectionManager.js";
import { closeMaster } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";
import { getBySlug, setLicense } from "../modules/tenants/index.js";
import { effectiveLicenseState } from "../modules/tenants/license.js";
import { env } from "../config/env.js";

const logger = createLogger({ service: "licence-cli" });

const DAY_MS = 24 * 60 * 60 * 1000;

/** The states §18 needs, and the licence window that produces each one. */
const STATES = ["active", "expiring", "grace", "expired"] as const;
type StateName = (typeof STATES)[number];

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

/**
 * The dates for each state, relative to now.
 *
 * `expiring` sits deliberately INSIDE `LICENSE_WARN_DAYS` rather than at its edge: a licence
 * expiring in exactly `LICENSE_WARN_DAYS` days is the boundary case, and a banner that fails to
 * appear there would be read as "the banner is broken" when it is the fixture that is ambiguous.
 * Half the window is unambiguously inside it.
 *
 * `expired` puts the END of grace in the past, not merely the expiry — expiry alone is GRACE.
 */
function windowFor(state: StateName, now: number): { expiresAt: Date; graceDays: number } | null {
  switch (state) {
    case "active":
      return null; // perpetual — see `clearExpiry`
    case "expiring":
      return {
        expiresAt: new Date(now + Math.max(1, Math.floor(env.LICENSE_WARN_DAYS / 2)) * DAY_MS),
        graceDays: env.LICENSE_DEFAULT_GRACE_DAYS,
      };
    case "grace":
      // Expired yesterday, with grace still open — the state where writes must STILL work.
      return { expiresAt: new Date(now - 1 * DAY_MS), graceDays: 7 };
    case "expired":
      // Expired 10 days ago with 1 day of grace, so grace closed 9 days ago.
      return { expiresAt: new Date(now - 10 * DAY_MS), graceDays: 1 };
  }
}

async function main(): Promise<void> {
  const slug = arg("--slug");
  const state = arg("--state") as StateName | undefined;
  const show = process.argv.includes("--show");

  if (!slug || (!show && !state)) {
    console.error(
      `Usage: licence --slug <slug> --state <${STATES.join("|")}>\n` +
        "       licence --slug <slug> --show",
    );
    process.exit(1);
  }

  const tenant = await getBySlug(slug);
  if (!tenant) throw new Error(`no tenant with slug "${slug}"`);

  /**
   * ── THE GUARD THAT MATTERS MORE THAN THE SCRIPT ─────────────────────────────
   * Expiring the wrong hospital ends the validation campaign it was meant to serve. The runbook
   * says to use a DEDICATED synthetic hospital for §18 and nothing enforced it, so this refuses
   * any slug that does not announce itself as a licence fixture. `--show` is read-only and is
   * therefore allowed anywhere, including production, where "what state is this hospital in?" is
   * a fair question to ask.
   */
  if (!show && !/licence|license/i.test(slug)) {
    throw new Error(
      `refusing to change the licence of "${slug}": §18 requires a DEDICATED hospital, and every ` +
        `other section of the runbook depends on the validation tenant still working. ` +
        `Provision one whose slug contains "licence" (e.g. licence-lab) and target that.`,
    );
  }

  if (state) {
    const now = Date.now();
    const window = windowFor(state, now);

    if (window === null) {
      /**
       * Perpetual is the ABSENCE of an expiry, and `applyLicensePatch` merges rather than
       * replaces, so there is no patch that clears it — passing `expiresAt: undefined` keeps the
       * old one. A far-future date is the honest way to say "not expiring" through the API this
       * script is allowed to use, and it reads as ACTIVE with a day count rather than as `null`.
       * The difference is visible only in the console's "perpetual" wording, which LIC-01 does not
       * assert.
       */
      await setLicense(tenant.id, {
        expiresAt: new Date(now + 3650 * DAY_MS),
        graceDays: env.LICENSE_DEFAULT_GRACE_DAYS,
        status: "ACTIVE",
        notes: "manual validation fixture: healthy licence (LIC-01)",
      });
    } else {
      await setLicense(tenant.id, {
        expiresAt: window.expiresAt,
        graceDays: window.graceDays,
        // The COMMERCIAL status stays ACTIVE on purpose: §18 is about the RUNTIME state, which is
        // computed from the dates. Setting status EXPIRED as well would test two things at once
        // and hide which of them the banner actually reads.
        status: "ACTIVE",
        notes: `manual validation fixture: ${state} (§18)`,
      });
    }
  }

  /**
   * Read back from the REGISTRY ENTRY, not from the write's own return value, and evaluate it with
   * `effectiveLicenseState` — the same denormalised fields and the same function `resolveTenant`
   * uses on every request. So what this prints is what the gate will decide, rather than what this
   * script believes it just wrote. A fixture tool that reports its own intentions is how a
   * validation session spends an hour testing a state the server was never in.
   */
  const after = await getBySlug(slug);
  const evaluated = effectiveLicenseState({
    expiresAt: after?.licenseExpiresAt ?? null,
    graceUntil: after?.licenseGraceUntil ?? null,
  });

  logger.info(
    {
      slug,
      requested: state ?? "(unchanged)",
      runtimeState: evaluated.state,
      daysRemaining: evaluated.daysRemaining,
      expiresAt: after?.licenseExpiresAt ? new Date(after.licenseExpiresAt).toISOString() : null,
      graceUntil: after?.licenseGraceUntil ? new Date(after.licenseGraceUntil).toISOString() : null,
      warnDays: env.LICENSE_WARN_DAYS,
    },
    "licence state",
  );

  if (state === "expiring" && evaluated.state !== "ACTIVE") {
    throw new Error(`expected ACTIVE inside the warning window, got ${evaluated.state}`);
  }
  if (state === "grace" && evaluated.state !== "GRACE") {
    throw new Error(`expected GRACE, got ${evaluated.state}`);
  }
  if (state === "expired" && evaluated.state !== "EXPIRED") {
    throw new Error(`expected EXPIRED, got ${evaluated.state}`);
  }
}

main()
  .catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "licence change failed",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
  });
