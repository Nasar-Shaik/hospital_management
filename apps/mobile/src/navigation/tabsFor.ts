/**
 * Permissions → navigation. The ONE place this conversion happens (M0 §8).
 *
 * ── NO `if (role === "DOCTOR")`, ANYWHERE ───────────────────────────────────
 * Roles are tenant-editable DATA: a hospital can rename DOCTOR to CONSULTANT, or build its own
 * role out of the same grants. Permissions are CODE — they live in `@medicore/permissions`, the
 * server authorizes against them, and they cannot drift per customer. Branching on a role string
 * would produce an app that works at the hospital it was written for and quietly loses a tab at
 * the next one.
 *
 * Role is used for exactly one thing, in `homeFor` below: which tab to land on. That is a
 * presentation default with a safe fallback, not an access decision.
 *
 * ── THIS HIDES; IT DOES NOT ENFORCE ─────────────────────────────────────────
 * Every route reached by deep link re-checks, and the server refuses regardless. A tab missing
 * from this list is a tab the user cannot usefully open — not a tab they are prevented from
 * reaching.
 */

/**
 * ── AND IT ANSWERS TO THE HOSPITAL'S EDITION TOO (M4) ───────────────────────
 * Permission is only half the question. A permission says "may this USER"; a feature flag says
 * "did this HOSPITAL buy it", and until M4 the phone read only the first — so a nurse holding
 * `nursing:manage` at a clinic with no IPD was offered a Ward tab whose every request could only
 * answer `HMS-PLAN-002`. The web shell has gated on both since D20; this is the same rule
 * reaching the other client, and it is why `tabsFor` now takes two sets.
 */

/** A tab is a route name plus the permissions required to see it. */
export interface TabDefinition {
  /** The Expo Router segment under `app/(app)/`. */
  name: string;
  title: string;
  /** Ionicons name — the icon set bundled with Expo. */
  icon: string;
  /** ALL of these are required. An empty list means "everyone signed in". */
  needs: readonly string[];
  /**
   * The module the hospital must have BOUGHT, when the tab belongs to one.
   *
   * Absent for the tabs every edition includes — the queue, the patient list, results, alerts and
   * billing all rest on `module.ops.opd`, which no edition is without. Naming a flag here that
   * every edition holds would be a switch nobody can turn off, which is the same mistake in the
   * other direction.
   */
  feature?: string;
}

/**
 * Ordered by how often a phone user reaches for them, not by module size. `alerts` is last and
 * needs nothing: every signed-in person has an inbox.
 */
export const TABS: readonly TabDefinition[] = [
  // `queue` is the route name from M1 and stays one: renaming a route breaks every deep link and
  // every saved shortcut. Only the LABEL changed, once the screen became the clinical home.
  { name: "queue", title: "Today", icon: "today-outline", needs: ["encounter:read"] },
  { name: "patients", title: "My patients", icon: "people-outline", needs: ["patient:read"] },
  { name: "orders", title: "Results", icon: "flask-outline", needs: ["order:read"] },
  /**
   * The nurse's home (M3-S3). `nursing:manage` rather than `emr:read`: the question this tab
   * answers is "do you WORK a ward", not "may you read a chart" — a pharmacist and a doctor both
   * hold `emr:read` and neither rounds from this screen. The screen itself still needs `emr:read`
   * and says so; the server refuses regardless.
   */
  {
    name: "ward",
    title: "Ward",
    icon: "bed-outline",
    needs: ["nursing:manage"],
    /**
     * `module.clinical.nursing`, NOT `module.ops.ipd`, and the distinction is the server's:
     * `GET /ward-worklist` is gated on the nursing flag because it returns dose slots — the same
     * thing the medication schedule returns, gated the same way. Beds are a different purchase.
     */
    feature: "module.clinical.nursing",
  },
  {
    name: "pharmacy",
    title: "Pharmacy",
    icon: "medkit-outline",
    needs: ["pharmacy:dispense"],
    feature: "module.pharmacy.dispensing",
  },
  { name: "billing", title: "Billing", icon: "cash-outline", needs: ["billing:read"] },
  { name: "alerts", title: "Alerts", icon: "notifications-outline", needs: [] },
] as const;

/**
 * More than this and the bar becomes unusable on a small phone; the surplus moves to a "More"
 * sheet. An administrator holding everything must not get a nine-tab bar.
 */
export const MAX_VISIBLE_TABS = 5;

/**
 * `bought` is optional so a caller that has not read `/auth/me` yet — or a test about
 * permissions alone — behaves exactly as it did before M4. An UNKNOWN edition shows every tab the
 * permissions allow, which is the right way round: the server refuses what it must, and a tab bar
 * that hid itself while the edition was still loading would flicker on every cold start.
 */
export function tabsFor(held: ReadonlySet<string>, bought?: ReadonlySet<string>): TabDefinition[] {
  return TABS.filter(
    (tab) =>
      tab.needs.every((permission) => held.has(permission)) &&
      (!tab.feature || !bought || bought.has(tab.feature)),
  );
}

/** What fits in the bar, and what is pushed into "More". */
export function splitTabs(
  held: ReadonlySet<string>,
  bought?: ReadonlySet<string>,
): {
  visible: TabDefinition[];
  overflow: TabDefinition[];
} {
  const all = tabsFor(held, bought);
  if (all.length <= MAX_VISIBLE_TABS) return { visible: all, overflow: [] };
  // `alerts` always keeps its place — a notification the user cannot find is a notification that
  // did not arrive — so the overflow is taken from the middle, not the end.
  const keep = all.slice(0, MAX_VISIBLE_TABS - 1);
  const last = all[all.length - 1];
  return {
    visible: last ? [...keep, last] : keep,
    overflow: all.slice(MAX_VISIBLE_TABS - 1, all.length - 1),
  };
}

/**
 * Where a role lands after sign-in.
 *
 * A doctor opening the app is going to a ward round; a cashier is going to a counter. Sending both
 * to the same list costs everybody a tap, every time. The mapping is a PREFERENCE — if the role is
 * unknown, or the preferred tab is not among the ones this user can see, it falls through to the
 * first available tab, so a renamed or custom role degrades to something sensible instead of a
 * blank screen.
 *
 * ── IT MUST MATCH AGAINST `visible`, NOT `tabsFor` ──────────────────────────
 * Those two differ for exactly the user this mapping was written for. A TENANT_ADMIN holds all six
 * tabs, so `billing` is pushed into the overflow — and matching against the full list landed them
 * on a screen with no tab in the bar and no way back to it. Caught by driving the real runtime
 * against a seeded admin, not by reading the code.
 */
const PREFERRED_HOME: Record<string, string> = {
  DOCTOR: "queue",
  NURSE: "queue",
  RECEPTIONIST: "patients",
  PHARMACIST: "pharmacy",
  LAB_TECHNICIAN: "orders",
  TENANT_ADMIN: "billing",
};

export function homeFor(
  roles: readonly string[],
  held: ReadonlySet<string>,
  bought?: ReadonlySet<string>,
): string | undefined {
  const { visible } = splitTabs(held, bought);
  for (const role of roles) {
    const preferred = PREFERRED_HOME[role];
    if (preferred && visible.some((tab) => tab.name === preferred)) return preferred;
  }
  return visible[0]?.name;
}
