/**
 * Per-tab sessions and quick sign-in — DEVELOPMENT ONLY.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
 * Testing a hospital means being several people at once: an admin in one tab, a doctor in the
 * next, a pharmacist in a third. But the refresh token is an httpOnly COOKIE, and a cookie is
 * shared by every tab of one hostname — so the last login wins and all tabs collapse onto one
 * account. The access token is per-tab (in memory), yet every reload and every silent refresh
 * falls back to that single shared cookie.
 *
 * ── THE FIX, AND WHY IT IS DEV-ONLY ──────────────────────────────────────────
 * The API already accepts the refresh token in the request BODY (the native-client path). So in
 * dev we keep each tab's refresh token in `sessionStorage` — which, unlike a cookie, is NOT
 * shared between tabs — and refresh from the body. Each tab then holds its own account, for real.
 *
 * This is gated hard on `NODE_ENV !== "production"` and must never ship on: `sessionStorage` is
 * readable by any script on the page, so putting a refresh token there trades away exactly the
 * XSS protection the httpOnly cookie exists to give. On a page that shows patient data that trade
 * is only acceptable on a developer's laptop, never in front of a patient.
 */

/** True only in local development. Every function here is inert otherwise. */
export const DEV_MULTI_ACCOUNT = process.env.NODE_ENV !== "production";

/** The one password every local account has (mirrors the API's dev seed). Dev-only, never a secret. */
export const DEV_PASSWORD = "123456";

// Per TAB (sessionStorage): the refresh token for THIS tab's account.
const REFRESH_KEY = "hms.dev.refreshToken";
// Per ORIGIN (localStorage): the accounts you have signed in as here, for one-click switching.
const ACCOUNTS_KEY = "hms.dev.accounts";

const hasWindow = (): boolean => typeof window !== "undefined";

/** This tab's refresh token, if per-tab sessions are on and one is stored. */
export function devRefreshToken(): string | undefined {
  if (!DEV_MULTI_ACCOUNT || !hasWindow()) return undefined;
  return window.sessionStorage.getItem(REFRESH_KEY) ?? undefined;
}

/** Store (or clear) this tab's refresh token. Called on every login and every rotation. */
export function setDevRefreshToken(token: string | undefined): void {
  if (!DEV_MULTI_ACCOUNT || !hasWindow()) return;
  if (token) window.sessionStorage.setItem(REFRESH_KEY, token);
  else window.sessionStorage.removeItem(REFRESH_KEY);
}

export interface RememberedAccount {
  email: string;
  name: string;
  role?: string;
}

/** The accounts signed in on this origin, most recent first — the quick-switch list. */
export function listRememberedAccounts(): RememberedAccount[] {
  if (!DEV_MULTI_ACCOUNT || !hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(ACCOUNTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as RememberedAccount[]) : [];
  } catch {
    return [];
  }
}

/** Remembers an account for quick sign-in, newest first, de-duplicated by email, capped. */
export function rememberAccount(account: RememberedAccount): void {
  if (!DEV_MULTI_ACCOUNT || !hasWindow()) return;
  const next = [account, ...listRememberedAccounts().filter((a) => a.email !== account.email)];
  window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(next.slice(0, 12)));
}

export function forgetAccount(email: string): void {
  if (!DEV_MULTI_ACCOUNT || !hasWindow()) return;
  const next = listRememberedAccounts().filter((a) => a.email !== email);
  window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(next));
}
