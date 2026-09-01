"use client";

/**
 * LicenseBanner — the renewal heads-up for a signed-in hospital (ADR-0016).
 *
 * Reads the licence state every API response carries (via `lib/licenseStatus`, fed by
 * the API client from the `X-License-State` header):
 *   EXPIRING — active but within LICENSE_WARN_DAYS of expiry: amber "expires in N days".
 *   GRACE    — past expiry, still inside the grace window: red "N days of grace left".
 * A hard-expired licence never reaches here — `resolveTenant` blocks the request, so
 * the app never renders for that hospital.
 *
 * The banner is dismissible, but the dismissal is keyed to the exact state signature:
 * a worsening state (EXPIRING → GRACE, or the day count dropping) re-shows it, so a
 * "close" earlier today cannot hide the day access is actually cut.
 */
import { useState, useSyncExternalStore } from "react";
import { getLicenseStatus, subscribeLicense } from "../lib/licenseStatus";
import { Alert } from "./ui";

export function LicenseBanner() {
  const status = useSyncExternalStore(subscribeLicense, getLicenseStatus, () => null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  if (!status || status.state === "ACTIVE") return null;

  const key = `${status.state}:${status.daysLeft ?? ""}`;
  if (dismissedKey === key) return null;

  const grace = status.state === "GRACE";
  const days = status.daysLeft;
  const dayLabel = days == null ? "" : `${String(days)} day${days === 1 ? "" : "s"}`;

  const message = grace
    ? `This hospital's subscription has lapsed${dayLabel ? ` — ${dayLabel} of grace remain` : ""} before access is blocked. Contact your platform administrator to renew.`
    : `This hospital's subscription expires${dayLabel ? ` in ${dayLabel}` : " soon"}. Contact your platform administrator to renew and avoid interruption.`;

  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-6 py-2">
      <Alert tone={grace ? "danger" : "warning"}>
        <div className="flex items-start justify-between gap-4">
          <span>{message}</span>
          <button
            type="button"
            onClick={() => setDismissedKey(key)}
            className="shrink-0 text-xs font-medium underline opacity-80 hover:opacity-100"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      </Alert>
    </div>
  );
}
