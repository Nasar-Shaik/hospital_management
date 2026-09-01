/**
 * `writeGuard` — the single answer to "may this submit button be enabled?" (M0 §11).
 *
 * Screens RENDER the reason; they do not compute it. Four unrelated conditions block a write and
 * each one was, in the web app, discovered separately by a user hitting it: offline, no branch
 * resolved, licence expired, permission missing. Computing them per screen means the fourth screen
 * gets three of the four.
 *
 * Note what is NOT here: any check that duplicates the server. This decides whether it is worth
 * ATTEMPTING a request. The server still decides whether it is allowed.
 */

export type WriteBlock = "offline" | "noBranch" | "licenceExpired" | "noPermission" | "readOnly";

export interface WriteGuardInput {
  online: boolean;
  /** True once `/me/branches` has been read AND a single branch is selected. */
  branchResolved: boolean;
  /** Whether this particular action needs one branch (every clinical/financial write does). */
  requiresBranch: boolean;
  licenceExpired: boolean;
  /** The permission this action needs, and the set the user holds. */
  needs?: string;
  held: ReadonlySet<string>;
}

export interface WriteGuardResult {
  canWrite: boolean;
  block?: WriteBlock;
  /** Shown next to the disabled control. Never a bare "disabled". */
  reason?: string;
}

const REASONS: Record<WriteBlock, string> = {
  offline: "You are offline. This cannot be saved until your device reconnects.",
  noBranch: "Choose which site you are working at before saving.",
  licenceExpired: "This hospital's subscription has lapsed. An administrator must renew it.",
  noPermission: "Your role does not include this action.",
  readOnly: "The system is temporarily read-only.",
};

/**
 * Order matters: the block reported is the one the user must fix FIRST. Telling a user they lack
 * permission when they are also offline sends them to an administrator for nothing.
 */
export function writeGuard(input: WriteGuardInput): WriteGuardResult {
  const blocked = (block: WriteBlock): WriteGuardResult => ({
    canWrite: false,
    block,
    reason: REASONS[block],
  });

  if (input.licenceExpired) return blocked("licenceExpired");
  if (input.needs && !input.held.has(input.needs)) return blocked("noPermission");
  if (!input.online) return blocked("offline");
  if (input.requiresBranch && !input.branchResolved) return blocked("noBranch");
  return { canWrite: true };
}
