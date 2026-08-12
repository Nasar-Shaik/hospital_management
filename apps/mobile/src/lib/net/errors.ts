/**
 * The ONE mapping of a failure to something a nurse can read (M0 §11).
 *
 * ── WHY THIS IS A MODULE AND NOT A `catch` BLOCK PER SCREEN ─────────────────
 * A policy re-implemented per screen is a policy that holds on the screens someone remembered. It
 * is written now, in M1, while there is one screen to prove it against; retrofitting it at M5
 * means auditing five features' worth of `catch` blocks, which is how "the payment screen shows a
 * raw traceId" ships.
 *
 * ── THE API'S MESSAGES ARE NOT THE USER'S MESSAGES ──────────────────────────
 * `ApiClientError.message` is written for a developer reading a log ("Insufficient permission").
 * It is never rendered. What is rendered comes from the CODE, because the code is the contract —
 * `ERROR_CODES.md` guarantees it, the message text does not, and a server-side rewording must not
 * change what a phone says.
 *
 * ── A FAILURE THAT IS NOT AN ApiClientError IS A NETWORK FAILURE ────────────
 * The client throws `ApiClientError` only once it has a response to read. A dropped connection, a
 * DNS failure or a timeout rejects `fetch` itself with a `TypeError`, so anything that is not an
 * `ApiClientError` is, from the app's point of view, "we could not reach the hospital". Saying
 * that is more accurate than any parse of the underlying message, which differs per platform.
 */
import { ApiClientError } from "@medicore/api-client";

export type Severity =
  /** Recoverable, in-place. Show near the thing that failed. */
  | "inline"
  /** Worth interrupting for, but the app still works. */
  | "notice"
  /** The app cannot continue in this state — a full screen, not a toast. */
  | "blocking";

/** What a screen renders. Nothing else about an error may reach the UI. */
export interface UserFacingError {
  title: string;
  body: string;
  severity: Severity;
  /** The label for the recovery affordance, when there is one worth offering. */
  action?: "retry" | "reload" | "signIn" | "pickBranch" | "contactAdmin";
  /** Field-level messages from a 400, keyed by field name — mapped straight onto a form. */
  fields?: Record<string, string[]>;
  /** Shown only behind a "Details" disclosure. The join key to the server's logs. */
  traceId?: string;
  /** The wire code, for the disclosure and for tests. Never rendered on its own. */
  code?: string;
}

/** True when the caller should hand this to the refresh flow rather than showing anything. */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiClientError && error.isUnauthenticated;
}

/** True when the failure was the transport, not the API. */
export function isNetworkFailure(error: unknown): boolean {
  return !(error instanceof ApiClientError);
}

/**
 * True when the branch the app thinks it is in is no longer usable, in either of the two ways the
 * server can say so: it refused the write for want of a branch (`HMS-BRANCH-001`), or it refused
 * the caller for this site (a 403). Both mean the same recovery — re-read `/me/branches` (M0 §7).
 */
export function isBranchProblem(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return false;
  return error.code === "HMS-BRANCH-001" || (error.status === 403 && error.code === "HMS-AUTH-005");
}

const GENERIC: UserFacingError = {
  title: "Something went wrong",
  body: "The action could not be completed. Please try again.",
  severity: "inline",
  action: "retry",
};

export function toUserMessage(error: unknown): UserFacingError {
  if (!(error instanceof ApiClientError)) {
    return {
      title: "No connection",
      body: "Your device cannot reach the hospital's system. Check your signal and try again.",
      severity: "notice",
      action: "retry",
    };
  }

  const base = { traceId: error.traceId, code: error.code };

  switch (error.code) {
    /* ── session ───────────────────────────────────────────────────────────── */
    case "HMS-AUTH-001":
      return {
        ...base,
        title: "Sign-in failed",
        body: "That email and password do not match. Check them and try again.",
        severity: "inline",
      };
    case "HMS-AUTH-002":
      return {
        ...base,
        title: "Session ended",
        body: "You have been signed out. Please sign in again.",
        severity: "blocking",
        action: "signIn",
      };
    case "HMS-AUTH-003":
      /**
       * Reuse detection revoked the whole token family (ADR-0009). This is a security event, and
       * the wording says so without alarming: the user needs to know their other sessions ended.
       */
      return {
        ...base,
        title: "Signed out for your security",
        body: "Your session was ended on all devices. Sign in again to continue.",
        severity: "blocking",
        action: "signIn",
      };
    case "HMS-AUTH-004":
      return {
        ...base,
        title: "Verification needed",
        body: "Enter the code from your authenticator app to continue.",
        severity: "inline",
      };

    /* ── authorization ─────────────────────────────────────────────────────── */
    case "HMS-AUTH-005":
      /**
       * Also a signal, not only a message: the cached permission set may be stale, so the caller
       * re-reads `/auth/me` (see `useCapabilities`). The user is told what to do about it, because
       * "you do not have access" with no next step is a support ticket.
       */
      return {
        ...base,
        title: "You do not have access",
        body: "Your role does not include this action. Ask an administrator if you need it.",
        severity: "inline",
        action: "contactAdmin",
      };
    case "HMS-PLAN-002":
      return {
        ...base,
        title: "Not included in this edition",
        body: "This hospital's plan does not include this feature.",
        severity: "inline",
        action: "contactAdmin",
      };
    case "HMS-PLAN-001":
      return {
        ...base,
        title: "Limit reached",
        body: "This hospital has reached a limit of its plan. An administrator can raise it.",
        severity: "inline",
        action: "contactAdmin",
      };

    /* ── tenant / licence ──────────────────────────────────────────────────── */
    case "HMS-TEN-001":
      return {
        ...base,
        title: "Hospital not found",
        body: "Check the hospital code you entered.",
        severity: "blocking",
      };
    case "HMS-TEN-002":
      return {
        ...base,
        title: "Hospital account suspended",
        body: "This hospital's account is suspended. Contact your administrator.",
        severity: "blocking",
      };
    case "HMS-TEN-003":
      /**
       * The token was minted at a different hospital. The app should never produce this — the
       * profile switch clears the session — so if it appears, the safe move is a clean sign-in
       * rather than any attempt to reconcile.
       */
      return {
        ...base,
        title: "Wrong hospital",
        body: "Your sign-in does not belong to this hospital. Please sign in again.",
        severity: "blocking",
        action: "signIn",
      };
    case "HMS-TEN-005":
      return {
        ...base,
        title: "Subscription expired",
        body: "This hospital's subscription has lapsed. An administrator must renew it before the app can be used.",
        severity: "blocking",
        action: "contactAdmin",
      };

    /* ── branch (ADR-0015) ─────────────────────────────────────────────────── */
    case "HMS-BRANCH-001":
      return {
        ...base,
        title: "Choose a branch",
        body: "Pick which site you are working at before saving.",
        severity: "inline",
        action: "pickBranch",
      };

    /* ── the request itself ────────────────────────────────────────────────── */
    case "HMS-VAL-001":
      return {
        ...base,
        title: "Check the form",
        body: "Some details need correcting.",
        severity: "inline",
        fields: error.fieldErrors,
      };
    case "HMS-REQ-001":
      return {
        ...base,
        title: "Too many attempts",
        body: "Please wait a moment before trying again.",
        severity: "notice",
        action: "retry",
      };
    case "HMS-REQ-002":
      /**
       * The SAME key was used for a DIFFERENT request — a client bug, not a user error, and the
       * one 409 that must never be presented as "try again": retrying re-sends the same mismatch.
       * Reloading is what actually recovers, because it re-reads the record and mints a new key.
       */
      return {
        ...base,
        title: "Already submitted",
        body: "This action was already sent under the same reference. Reload to see the current state.",
        severity: "notice",
        action: "reload",
      };
    case "HMS-REQ-003":
      return {
        ...base,
        title: "Changed by someone else",
        body: "This record was updated while you were working on it. Reload and reapply your changes.",
        severity: "notice",
        action: "reload",
      };
    case "HMS-REQ-004":
      return {
        ...base,
        title: "Still going through",
        body: "Your previous attempt is still being processed. Wait a moment — do not submit again.",
        severity: "notice",
        action: "retry",
      };

    /* ── the server ────────────────────────────────────────────────────────── */
    case "HMS-GEN-404":
      return {
        ...base,
        title: "Not found",
        body: "That record is not available here. It may belong to another branch.",
        severity: "inline",
      };
    case "HMS-GEN-503":
    case "HMS-TEN-004":
      return {
        ...base,
        title: "Temporarily unavailable",
        body: "The hospital's system is briefly unavailable. Try again shortly.",
        severity: "notice",
        action: "retry",
      };
    default:
      /**
       * An unknown code is still shown as a generic failure with its traceId, never as
       * `error.message`. A code we have not mapped yet is a gap in this file, and rendering the
       * server's developer-facing text would hide that gap behind something that looks deliberate.
       */
      if (error.status >= 500) {
        return {
          ...base,
          title: "The hospital's system is not responding",
          body: "This is not something you did. Try again, and report it if it continues.",
          severity: "notice",
          action: "retry",
        };
      }
      return { ...GENERIC, ...base };
  }
}
