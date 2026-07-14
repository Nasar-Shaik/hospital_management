/**
 * ENVIRONMENT PROFILES — the one place that knows how local differs from production.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * Three real bugs, all the same shape:
 *
 *   1. `TENANT_BASE_DOMAIN` defaulted to the PRODUCTION domain, so an
 *      unconfigured dev machine was silently set up to serve production — and
 *      because `*.paperlesstech.in` has wildcard DNS pointing at the live server,
 *      following our own docs sent a developer's browser off the machine.
 *   2. The API bound `0.0.0.0` (IPv4 only) while `<slug>.localhost` resolves to
 *      `::1` first, so the browser could not reach an API that `curl` said was
 *      perfectly healthy.
 *   3. The minimum password length was written in three files that disagreed.
 *
 * None was a hard problem. Each was a setting that varied by environment with
 * nowhere to live, so it got hardcoded somewhere convenient and then drifted.
 * This file is that home.
 *
 * ── WHY NOT ONE BIG `environmentConfigs.ts` WITH LOCAL *AND* PROD VALUES ──────
 * Because production values include SECRETS — the JWT signing key, the database
 * password, the field-encryption key. A file in git cannot hold them: git history
 * is forever, every developer and CI runner clones it, and a leaked repository
 * would be a leaked hospital. So the rule is:
 *
 *      NON-SECRET, environment-shaped   →  here, in code, reviewed, in git
 *      SECRET, or deployment-specific   →  environment variables ONLY
 *
 * You get the single readable file you wanted, and secrets stay out of it by
 * construction rather than by everyone remembering.
 *
 * ── HOW A VALUE IS RESOLVED (precedence, lowest to highest) ───────────────────
 *
 *      1. Zod schema default            (env.ts)      "the universal default"
 *      2. Profile default               (this file)   "what LOCAL/PROD usually wants"
 *      3. Environment variable          (.env, K8s)   "what THIS deployment wants"
 *      4. Production invariant          (this file)   "what a hospital gets, period"
 *
 * Layer 4 is the important one and the reason this is not just a defaults file.
 * An invariant is not a default — it cannot be overridden. A stray
 * `PASSWORD_MIN_LENGTH=6` in a production .env (copied from a dev machine, pasted
 * from a wiki, left by a rollback) is IGNORED and reported. Security properties
 * that depend on nobody making a configuration mistake are not security
 * properties; they are hopes.
 */

/** `test` is its own profile: hermetic, throwaway, and must never touch a real host. */
export type Profile = "local" | "test" | "production";

export function activeProfile(nodeEnv: string): Profile {
  if (nodeEnv === "production") return "production";
  if (nodeEnv === "test") return "test";
  return "local";
}

/**
 * Defaults applied when the environment does NOT set the variable.
 *
 * Only non-secret, environment-shaped settings belong here. If you are tempted to
 * add a password, a key or a connection string with credentials in it, stop — that
 * is an environment variable, and the fact that it feels convenient here is
 * exactly how secrets end up in git.
 */
export const PROFILE_DEFAULTS: Record<Profile, Record<string, string>> = {
  local: {
    /**
     * `<slug>.localhost` resolves to 127.0.0.1 (and ::1) on every modern browser
     * with no /etc/hosts entry and no DNS lookup at all. It cannot leave the
     * machine — which is the entire point. NEVER default this to a real domain:
     * that is bug #1 above.
     */
    TENANT_BASE_DOMAIN: "localhost",

    /**
     * Empty = Node listens dual-stack (`::` plus IPv4-mapped). Required, not
     * cosmetic: `demo.localhost` resolves to `::1` BEFORE `127.0.0.1` on macOS,
     * so an IPv4-only bind is unreachable from a browser while looking perfectly
     * healthy to curl (which quietly falls back to IPv4). That is bug #2.
     */
    API_BIND: "",

    /**
     * Local passwords are typed dozens of times a day against a throwaway
     * database. `123456` is fine there and buys nothing when made strong.
     * The production invariant below is what makes this safe to allow.
     */
    PASSWORD_MIN_LENGTH: "6",
    PASSWORD_REQUIRE_COMPLEXITY: "false",

    LOG_LEVEL: "debug",
  },

  test: {
    /**
     * `.test` is RESERVED by RFC 6761 and can never resolve on the public
     * internet. A test suite must be incapable of reaching a system it is not
     * testing — even by accident, even through a stray DNS lookup.
     */
    TENANT_BASE_DOMAIN: "medicore.test",
    API_BIND: "127.0.0.1",
    LOG_LEVEL: "silent",

    /**
     * The password policy is deliberately NOT relaxed here — the schema defaults
     * (12 chars + complexity) apply, which are the PRODUCTION policy.
     *
     * A suite that tests a weakened policy proves nothing about the one a hospital
     * runs. The tests must exercise the rules that actually ship.
     */
  },

  production: {
    /**
     * Loopback: the API is reachable only through the gateway, so a misconfigured
     * firewall cannot expose Express to the internet. Containers override this
     * with API_BIND=0.0.0.0, which is correct — a container network is not the
     * internet, and the gateway is still the only way in.
     */
    API_BIND: "127.0.0.1",
    LOG_LEVEL: "info",

    /**
     * TENANT_BASE_DOMAIN is deliberately ABSENT.
     *
     * There is no sensible default for "which domain is this platform served on",
     * and guessing produces bug #1. Production must name its own domain, out
     * loud, in its own environment. If it does not, the schema default
     * (`localhost`) applies and the deployment serves nobody — which is a loud,
     * immediate, harmless failure, and infinitely better than a quiet one.
     */
  },
};

/** A production setting that was overridden because it was unsafe. */
export interface Violation {
  key: string;
  attempted: string;
  enforced: string;
  why: string;
}

/** The password policy a hospital gets, whatever its configuration asks for. */
const PRODUCTION_MIN_PASSWORD_LENGTH = 12;

/**
 * The non-negotiables. Applied AFTER the environment has had its say, so nothing
 * a deployment sets can weaken them.
 *
 * Overriding beats refusing to boot. An API that will not start takes a hospital
 * offline, which is a worse outcome than an API that starts with the CORRECT
 * setting and shouts about the mistake — so this repairs and reports rather than
 * exiting. The report is not decoration: it is how the mistake gets fixed before
 * it becomes a habit.
 *
 * Add to this list any property where "someone might misconfigure it" is an
 * unacceptable answer.
 */
export function applyProductionInvariants(config: Record<string, unknown>): Violation[] {
  const violations: Violation[] = [];

  const minLength = Number(config.PASSWORD_MIN_LENGTH);
  if (minLength < PRODUCTION_MIN_PASSWORD_LENGTH) {
    violations.push({
      key: "PASSWORD_MIN_LENGTH",
      attempted: String(minLength),
      enforced: String(PRODUCTION_MIN_PASSWORD_LENGTH),
      why: "a hospital's records may not be protected by a PIN",
    });
    config.PASSWORD_MIN_LENGTH = PRODUCTION_MIN_PASSWORD_LENGTH;
  }

  if (config.PASSWORD_REQUIRE_COMPLEXITY !== true) {
    violations.push({
      key: "PASSWORD_REQUIRE_COMPLEXITY",
      attempted: String(config.PASSWORD_REQUIRE_COMPLEXITY),
      enforced: "true",
      why: "complexity may be relaxed for local development only",
    });
    config.PASSWORD_REQUIRE_COMPLEXITY = true;
  }

  return violations;
}
