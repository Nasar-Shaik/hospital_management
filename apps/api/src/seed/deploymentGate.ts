/**
 * MAY THIS RELEASE ROLL OUT? — the fleet answer, in a form a deploy step can read.
 *
 * ── WHERE THIS SITS ─────────────────────────────────────────────────────────
 * RELEASE_MANAGEMENT §5 defines the order for a schema-coupled release: stand up green → run
 * migrations → shift traffic. This is the step BETWEEN the second and the third. It answers one
 * question — "is every tenant on a schema this build can serve?" — and it answers it without
 * changing anything, because a check that migrates while it looks cannot be run twice and cannot
 * be trusted once.
 *
 * ── WHY THE ANSWER IS NOT A BOOLEAN ─────────────────────────────────────────
 * `migrate --check` already walked the fleet and already exited non-zero, and that was most of the
 * way there. What it could not do was tell a deploy tool WHICH kind of no it was giving:
 *
 *   "tenant `apollo` is two migrations behind"          → converge it, then deploy
 *   "tenant `apollo` was unreachable for 2 seconds"     → nothing is known; retry
 *
 * Both exited 1, so both read as "the schema is wrong" — and the printed advice for both was "run
 * `migrate --all`", which for the second is an instruction to migrate a database nobody can reach.
 * Every operational hiccup looked exactly like schema drift, which is how a gate gets a `|| true`
 * appended to it inside a month.
 *
 * So the verdict has three values and the reasons have seven categories. NOT_READY means the
 * schema was inspected and is wrong. ERROR means the question could not be answered. Both stop a
 * release — the gate fails closed, always — but only one of them is a reason to page someone
 * about a migration.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 * It does not migrate, seed, repair, or retry. It does not watch: it answers when asked, which is
 * a strictly weaker thing than the scraped gauge RISK_REGISTER T2 wants, and T2 stays open.
 */
import type { Connection } from "mongoose";
import type { Migration } from "../core/db/migrations/runner.js";
import { verifyTenantSchema, type SchemaVerdict } from "./schemaGuard.js";

/**
 * Why a tenant is not ready — or why we cannot say.
 *
 * The split down the middle is the load-bearing part: the first four are findings ABOUT THE SCHEMA,
 * reached by successfully inspecting a database. The last two are failures to inspect at all, and
 * carry no information about the schema whatsoever.
 */
export type ReadinessCode =
  /** Inspected, converged, and every clinical invariant is armed in the database. */
  | "ready"
  /** Migrations outstanding, history otherwise sound. Converge, then re-check. */
  | "behind"
  /** Outstanding, AND the next one refuses on the data already there. Converging will fail. */
  | "preflight_blocked"
  /** Every migration recorded, but a constraint the clinical rules rest on is not in the database. */
  | "schema_drift"
  /** A history that running these migrations in order could not have produced. */
  | "history_inconsistent"
  /** The registry row cannot be trusted enough to know which database to open. */
  | "malformed"
  /** The database could not be reached or inspected. Says nothing about its schema. */
  | "unreachable";

/** `NOT_READY` = we looked and it is wrong. `ERROR` = we could not look. Neither may deploy. */
export type FleetVerdict = "READY" | "NOT_READY" | "ERROR";

/**
 * The process exit contract, stable and the reason this module exists.
 *
 * 0/1 was already the convention here and keeps its meaning exactly. 2 is new and is the whole
 * point: a deploy script that retries on 2 and pages on 1 is doing the right thing in both cases,
 * and could not previously tell them apart.
 */
export const EXIT_CODE: Readonly<Record<FleetVerdict, number>> = {
  READY: 0,
  NOT_READY: 1,
  ERROR: 2,
};

const IS_ERROR: ReadonlySet<ReadinessCode> = new Set<ReadinessCode>(["malformed", "unreachable"]);

export interface TenantReadiness {
  slug: string;
  code: ReadinessCode;
  /** True only for `ready`. Deploy on the fleet verdict, never on this. */
  ready: boolean;
  /** Machine-usable specifics: pending ids, inconsistent findings, the connection error. */
  detail: string[];
  /**
   * True things that are NOT failures. `ahead` lives here: a tenant carrying migrations from a
   * newer release is on an expanded schema this build can serve, and blocking it would make every
   * rollback impossible.
   */
  notes: string[];
  /** What the person reading this should actually do. */
  remedy: string;
}

export interface FleetReport {
  verdict: FleetVerdict;
  checkedAt: string;
  /** The migration set this answer was computed against — an answer is only true of one release. */
  release: { migrations: number; head: string };
  total: number;
  ready: number;
  notReady: number;
  errored: number;
  tenants: TenantReadiness[];
}

/* ── the registry row, before it is trusted ─────────────────────────────────── */

/**
 * What `migrate --check` needs from a tenant to inspect it at all.
 *
 * ── WHY THIS IS VALIDATED RATHER THAN COERCED ───────────────────────────────
 * The fleet loop used to build these with `String(doc.databaseName)`. Measured, 2026-08-16: a
 * registry row missing `databaseName` yields the literal string `"undefined"`, mongoose opens a
 * database CALLED `undefined`, and the check finds it empty — so it reports 49 migrations pending
 * and both safety invariants missing. The operator is told a real tenant has drifted, and the
 * remedy printed alongside would have run migrations against a junk database and created it.
 * An empty string is worse and quieter: mongoose resolves it to `test` and the check confidently
 * describes a completely different database.
 *
 * A row we cannot read is its own answer, and it is an ERROR — not a schema finding.
 */
export interface TenantTarget {
  id: string;
  slug: string;
  databaseName: string;
  dbUri?: string;
}

/**
 * What a tenant database may be called: `hms_<slug>`, so letters, digits, `_` and `-`.
 *
 * An ALLOW-list, not a list of the characters MongoDB rejects. Both would catch `hms/apollo`, but
 * a deny-list has to stay complete forever — it is one forgotten character (a NUL, a newline) away
 * from passing a name straight through to a connection string.
 */
const LEGAL_DB_NAME = /^[A-Za-z0-9_-]+$/;

export function validateTarget(row: {
  id?: unknown;
  slug?: unknown;
  databaseName?: unknown;
  dbUri?: unknown;
}): { ok: true; target: TenantTarget } | { ok: false; slug: string; problems: string[] } {
  const problems: string[] = [];
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value : null;

  const id = text(row.id);
  const slug = text(row.slug);
  const databaseName = text(row.databaseName);

  if (id === null) problems.push("`_id` is missing or blank");
  if (slug === null) problems.push("`slug` is missing or blank");
  if (databaseName === null) {
    problems.push("`databaseName` is missing or blank — there is no database to inspect");
  } else if (!LEGAL_DB_NAME.test(databaseName)) {
    problems.push(
      `\`databaseName\` (${databaseName}) is not a legal database name — expected letters, ` +
        "digits, `_` or `-`",
    );
  }
  if (row.dbUri !== undefined && text(row.dbUri) === null) {
    problems.push("`dbUri` is present but blank — either give it a value or remove the field");
  }

  if (id === null || slug === null || databaseName === null || problems.length > 0) {
    return { ok: false, slug: slug ?? "(unnamed row)", problems };
  }
  return {
    ok: true,
    target: {
      id,
      slug,
      databaseName,
      ...(typeof row.dbUri === "string" ? { dbUri: row.dbUri } : {}),
    },
  };
}

/* ── one tenant ─────────────────────────────────────────────────────────────── */

/**
 * Turn a schema verdict into a category and an instruction.
 *
 * ── THE ORDER IS THE DESIGN ─────────────────────────────────────────────────
 * A tenant can be several kinds of wrong at once, and the reader needs the one that determines
 * what to do next. An inconsistent history outranks everything because converging is actively
 * unsafe against it. A blocked preflight outranks "behind" because the obvious next step will
 * fail. Drift is checked LAST of the schema findings and only when nothing is pending — a tenant
 * that is behind is naturally missing the indexes those migrations install, and calling that
 * "drift" would send the reader to the one remedy (clear the record) that does not apply.
 */
export function classify(verdict: SchemaVerdict, slug: string): Omit<TenantReadiness, "slug"> {
  const notes =
    verdict.history.ahead.length > 0
      ? [
          `on a NEWER schema than this release: ${verdict.history.ahead.join(", ")}. Serving is ` +
            "safe (expand→migrate→contract), but this build is older than the fleet's schema.",
        ]
      : [];

  const of = (
    code: ReadinessCode,
    detail: string[],
    remedy: string,
  ): Omit<TenantReadiness, "slug"> => ({ code, ready: code === "ready", detail, notes, remedy });

  if (verdict.history.inconsistent.length > 0) {
    return of(
      "history_inconsistent",
      verdict.history.inconsistent,
      "Do NOT converge. Find out where this history came from — a partial restore, a hand-edited " +
        "`migrations` collection, or a database migrated by a different build.",
    );
  }

  if (verdict.blockedBy) {
    return of(
      "preflight_blocked",
      [`${verdict.blockedBy.migration} refuses`, verdict.blockedBy.reason],
      `Converging will fail. Resolve what \`${verdict.blockedBy.migration}\` reports, then ` +
        `\`pnpm seed:migrate --slug ${slug}\`.`,
    );
  }

  if (verdict.pending.length > 0) {
    return of(
      "behind",
      verdict.pending,
      `\`pnpm seed:migrate --slug ${slug}\` (or \`--all\`), then check again.`,
    );
  }

  if (verdict.missing.length > 0) {
    return of(
      "schema_drift",
      verdict.missing.map((m) => `${m.invariant.rule}: ${m.found}`),
      "Every migration is RECORDED, so `seed:migrate` will skip it and report success while " +
        "changing nothing. Clear the record for " +
        verdict.missing.map((m) => `\`${m.invariant.migration}\``).join(", ") +
        ` then \`pnpm seed:migrate --slug ${slug}\`. Something dropped this index — that is worth ` +
        "understanding before it is simply replaced.",
    );
  }

  return of("ready", [], "");
}

/**
 * Inspect one tenant. Never throws: an uninspectable tenant is a RESULT, because a gate that dies
 * on the first unreachable database tells you nothing about the other 30.
 */
export async function checkTenant(
  target: TenantTarget,
  connect: (target: TenantTarget) => Promise<Connection>,
  migrations: Migration[],
): Promise<TenantReadiness> {
  try {
    const connection = await connect(target);
    const verdict = await verifyTenantSchema(connection, migrations);
    return { slug: target.slug, ...classify(verdict, target.slug) };
  } catch (err) {
    return {
      slug: target.slug,
      code: "unreachable",
      ready: false,
      detail: [err instanceof Error ? err.message : String(err)],
      notes: [],
      remedy:
        "This says NOTHING about the tenant's schema — it was never inspected. Restore access " +
        "and run the check again before drawing any conclusion about this release.",
    };
  }
}

/* ── the fleet ──────────────────────────────────────────────────────────────── */

/**
 * ── WHY ERROR OUTRANKS NOT_READY ────────────────────────────────────────────
 * If one tenant is behind and another is unreachable, the honest headline is not "the fleet is
 * behind" — it is "this check did not complete". Reporting NOT_READY would imply the unreachable
 * tenant had been inspected and found acceptable. Both stop the release either way; the difference
 * is what the operator is told they know.
 */
export function fleetVerdict(tenants: readonly TenantReadiness[]): FleetVerdict {
  if (tenants.some((t) => IS_ERROR.has(t.code))) return "ERROR";
  if (tenants.some((t) => !t.ready)) return "NOT_READY";
  return "READY";
}

export function report(tenants: TenantReadiness[], migrations: Migration[]): FleetReport {
  return {
    verdict: fleetVerdict(tenants),
    checkedAt: new Date().toISOString(),
    release: {
      migrations: migrations.length,
      head: migrations.at(-1)?.id ?? "(none)",
    },
    total: tenants.length,
    ready: tenants.filter((t) => t.ready).length,
    notReady: tenants.filter((t) => !t.ready && !IS_ERROR.has(t.code)).length,
    errored: tenants.filter((t) => IS_ERROR.has(t.code)).length,
    tenants,
  };
}

/**
 * A tenant whose registry row never got as far as a connection attempt.
 *
 * An empty fleet is deliberately its own case elsewhere: zero tenants trivially satisfies "every
 * tenant is ready", and a gate that answers READY because it found nothing to check is the most
 * dangerous answer it could give.
 */
export function malformed(slug: string, problems: string[]): TenantReadiness {
  return {
    slug,
    code: "malformed",
    ready: false,
    detail: problems,
    notes: [],
    remedy:
      "Fix the row in the master `tenants` collection. Until then this tenant cannot be checked " +
      "— and it must not be migrated, because a bad `databaseName` resolves to a real but WRONG " +
      "database rather than to an error.",
  };
}
