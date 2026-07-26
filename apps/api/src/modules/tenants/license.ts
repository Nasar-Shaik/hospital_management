/**
 * Per-tenant licence logic (ADR-0016) — the pure half: no I/O, no DB.
 *
 * A licence is a validity window (`validFrom → expiresAt`) plus a grace window
 * (`graceDays` after expiry). `effectiveLicenseState` is the ONE function that
 * decides "is this hospital allowed to run right now?", and it is shared by BOTH
 * the request gate (`resolveTenant`, enforcement) and the operator console
 * (display) so the two can never disagree.
 *
 * The expiry is denormalised onto the cached registry entry as epoch milliseconds
 * (see tenant.repository `toEntry`), so the gate is a single in-process integer
 * compare on the hot path — no master round-trip, and expiry fires to the second.
 */
import { env } from "../../config/env.js";
import type { TenantLicense } from "./tenant.model.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Runtime state, distinct from the stored `LicenseStatus` (which is the commercial lifecycle). */
export type LicenseRuntimeState = "ACTIVE" | "GRACE" | "EXPIRED";

export interface LicenseEvaluation {
  state: LicenseRuntimeState;
  /**
   * ACTIVE: days until expiry (null = perpetual). GRACE: days until the grace window
   * closes and access is cut. EXPIRED: 0.
   */
  daysRemaining: number | null;
}

/**
 * ACTIVE = fine (or no expiry set = perpetual); GRACE = past expiry but inside the
 * grace window (still runs, warn loudly); EXPIRED = past grace (blocked).
 *
 * Times are epoch milliseconds — the shape the registry entry carries, so the caller
 * on the hot path does no Date parsing.
 */
export function effectiveLicenseState(
  lic: { expiresAt?: number | null; graceUntil?: number | null },
  nowMs: number = Date.now(),
): LicenseEvaluation {
  const expiresAt = lic.expiresAt ?? null;
  const graceUntil = lic.graceUntil ?? expiresAt;

  if (expiresAt == null) return { state: "ACTIVE", daysRemaining: null }; // perpetual / unset
  if (nowMs <= expiresAt) {
    return { state: "ACTIVE", daysRemaining: Math.ceil((expiresAt - nowMs) / DAY_MS) };
  }
  if (graceUntil != null && nowMs <= graceUntil) {
    return { state: "GRACE", daysRemaining: Math.ceil((graceUntil - nowMs) / DAY_MS) };
  }
  return { state: "EXPIRED", daysRemaining: 0 };
}

/** graceUntil = expiresAt + graceDays (or null when there is no expiry = perpetual). */
export function computeGraceUntil(expiresAt?: Date | null, graceDays?: number | null): Date | null {
  if (!expiresAt) return null;
  const days = Number.isFinite(graceDays) ? Number(graceDays) : env.LICENSE_DEFAULT_GRACE_DAYS;
  return new Date(new Date(expiresAt).getTime() + days * DAY_MS);
}

/** A fresh trial licence for a newly provisioned hospital (used when no expiry is supplied). */
export function buildTrialLicense(now: Date = new Date()): TenantLicense {
  return {
    plan: "TRIAL",
    status: "TRIAL",
    validFrom: now,
    expiresAt: new Date(now.getTime() + env.LICENSE_DEFAULT_TRIAL_DAYS * DAY_MS),
    graceDays: env.LICENSE_DEFAULT_GRACE_DAYS,
    lastRenewedAt: now,
    notes: "",
  };
}

/** Patch to build a licence at provisioning from operator input (or fall back to a trial). */
export interface LicenseProvisionInput {
  plan?: string;
  /** Explicit expiry. Wins over `trialDays`. */
  expiresAt?: Date;
  /** Convenience: expire this many days from now. Ignored when `expiresAt` is given. */
  trialDays?: number;
  graceDays?: number;
  notes?: string;
}

/** Resolve the licence a new hospital should be created with. */
export function buildProvisionLicense(
  input: LicenseProvisionInput | undefined,
  now: Date = new Date(),
): TenantLicense {
  if (!input || (input.expiresAt == null && input.trialDays == null && input.plan == null)) {
    return buildTrialLicense(now);
  }
  const expiresAt =
    input.expiresAt ??
    (input.trialDays != null
      ? new Date(now.getTime() + input.trialDays * DAY_MS)
      : new Date(now.getTime() + env.LICENSE_DEFAULT_TRIAL_DAYS * DAY_MS));
  return {
    plan: (input.plan ?? "TRIAL").trim(),
    status: "ACTIVE",
    validFrom: now,
    expiresAt,
    graceDays: input.graceDays ?? env.LICENSE_DEFAULT_GRACE_DAYS,
    lastRenewedAt: now,
    notes: input.notes ?? "",
  };
}

/** Patch accepted by `setLicense` — set fields directly and/or extend by N days. */
export interface LicensePatch {
  plan?: string;
  status?: TenantLicense["status"];
  validFrom?: Date;
  expiresAt?: Date;
  graceDays?: number;
  notes?: string;
  /** Bump expiry by N days from the LATER of now / current expiry — a renewal never shortens. */
  extendDays?: number;
}

/**
 * Merge a patch onto an existing licence into a normalised licence. `extendDays` is
 * resolved here: it renews from the later of now or the current expiry, so extending
 * an already-future licence adds to it rather than truncating it.
 */
export function applyLicensePatch(
  existing: TenantLicense | undefined,
  patch: LicensePatch,
  now: Date = new Date(),
): TenantLicense {
  const current = existing ?? {};
  const next: LicensePatch = { ...patch };

  const extended = patch.extendDays != null && Number.isFinite(patch.extendDays);
  if (extended) {
    const base = Math.max(
      now.getTime(),
      current.expiresAt ? new Date(current.expiresAt).getTime() : 0,
    );
    next.expiresAt = new Date(base + (patch.extendDays as number) * DAY_MS);
    if (!patch.status) next.status = "ACTIVE";
  }
  delete next.extendDays;

  const graceDays = Number.isFinite(next.graceDays)
    ? Number(next.graceDays)
    : (current.graceDays ?? env.LICENSE_DEFAULT_GRACE_DAYS);

  // A change that moves the expiry is a renewal — stamp it.
  const touchedExpiry = extended || next.expiresAt != null;
  const resolved: TenantLicense = {
    plan: (next.plan ?? current.plan ?? "TRIAL").trim(),
    status: next.status ?? current.status ?? "ACTIVE",
    graceDays,
    lastRenewedAt: touchedExpiry ? now : current.lastRenewedAt,
    notes: next.notes != null ? String(next.notes) : (current.notes ?? ""),
  };
  const validFrom = next.validFrom ?? current.validFrom;
  if (validFrom) resolved.validFrom = validFrom;
  const expiresAt = next.expiresAt ?? current.expiresAt;
  if (expiresAt) resolved.expiresAt = expiresAt;
  return resolved;
}
