/**
 * Auth controller — HTTP only (Doc 09 §11).
 *
 * Controllers translate HTTP to service calls and back. No business rules, no
 * database, no token logic: all of that is in auth.service.ts, which is why the
 * service is testable without Express and reusable from the CLI.
 *
 * The refresh token is set as an httpOnly cookie AND returned in the body:
 * browsers use the cookie (immune to XSS exfiltration), mobile/native clients
 * read the body and store it in the OS keychain (Doc 04 §4.2). Same token, two
 * transports.
 */
import type { Request, RequestHandler, Response } from "express";
import { env } from "../../config/env.js";
import { requireAuth } from "../../middleware/authenticate.js";
import { AppError, SessionExpiredError } from "../../core/errors/appError.js";
import * as authService from "./auth.service.js";
import type { DeviceInfo, LoginResult, TokenPair } from "./auth.service.js";
import { ok } from "../../core/http/respond.js";

const REFRESH_COOKIE = "hms_refresh";

function deviceInfo(req: Request, device?: string): DeviceInfo {
  return {
    ...(req.ip ? { ip: req.ip } : {}),
    ...(req.headers["user-agent"] ? { userAgent: req.headers["user-agent"] } : {}),
    ...(device ? { device } : {}),
  };
}

function setRefreshCookie(res: Response, refreshToken: string): void {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true, // unreadable from JavaScript — the point of the cookie
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    /**
     * Path `/`, not `/api/v1/auth`.
     *
     * The web app and the API share a hostname (the hostname IS the tenant), and
     * Next.js middleware must see this cookie to decide "logged in?" before it
     * renders a protected page. A path-scoped cookie is invisible to it, which
     * would force the guard to live in client JavaScript after the page has
     * already been served.
     *
     * It costs the cookie being sent on same-host requests it isn't needed for.
     * It is httpOnly and useless without the tenant + a valid family, so the
     * trade is a few bytes for a server-side route guard.
     */
    path: "/",
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: "/" });
}

/** The refresh token may arrive from the cookie (web) or the body (mobile). */
function presentedRefreshToken(req: Request): string | undefined {
  const body = req.body as { refreshToken?: string } | undefined;
  const cookies = req.cookies as Record<string, string> | undefined;
  return body?.refreshToken ?? cookies?.[REFRESH_COOKIE];
}

function respondWithTokens(res: Response, result: TokenPair): void {
  setRefreshCookie(res, result.refreshToken);
  ok(res, result);
}

export const login: RequestHandler = async (req, res) => {
  const { email, password, device } = req.body as {
    email: string;
    password: string;
    device?: string;
  };

  const result: LoginResult = await authService.login(email, password, deviceInfo(req, device));

  if (authService.isMfaChallenge(result)) {
    // 200, not 403: the password step SUCCEEDED. The client is expected to
    // continue the flow, not to treat this as a failure.
    ok(res, result);
    return;
  }
  respondWithTokens(res, result);
};

/**
 * ── WHY A REJECTED REFRESH MUST CLEAR THE COOKIE ─────────────────────────────
 * A token we have just declared dead is not merely useless — left in place it is
 * ACTIVELY HARMFUL, and it locked a real user out of the application entirely.
 *
 * The cookie is httpOnly, so no client code can remove it, and the Next.js route
 * guard reads its PRESENCE as "signed in". So: /dashboard is allowed to render,
 * its refresh 401s, the app redirects to /login, and the guard — still seeing the
 * cookie — sends the browser straight back to /dashboard, where it STOPS. Not a
 * spinning loop; something quieter and harder to diagnose. A permanently blank
 * page at a URL that looks correct, with no way to reach the login form.
 *
 * The user cannot sign in, cannot sign out, and cannot fix it by restarting the
 * server — the broken state is in their cookie jar, not ours. We are the only
 * party who knows the token is dead, and the only party able to remove it.
 *
 * Only on 401. A 500 from a database blip means "ask me again", not "you are
 * logged out" — clearing on any error would sign out every user in the hospital
 * the moment Mongo hiccuped, turning a blip into an outage.
 */
export const refresh: RequestHandler = async (req, res) => {
  const token = presentedRefreshToken(req);
  if (!token) {
    clearRefreshCookie(res);
    // Same error a bad token gets — an absent cookie is not more informative.
    throw new SessionExpiredError({ reason: "no refresh token presented" });
  }

  try {
    respondWithTokens(res, await authService.refresh(token, deviceInfo(req)));
  } catch (err) {
    if (err instanceof AppError && err.httpStatus === 401) clearRefreshCookie(res);
    throw err;
  }
};

export const logout: RequestHandler = async (req, res) => {
  const auth = requireAuth(req);
  const token = presentedRefreshToken(req);

  await authService.logout({
    ...(token ? { refreshToken: token } : {}),
    accessJti: auth.jti,
    accessExpiresAt: auth.expiresAt,
  });

  clearRefreshCookie(res);
  ok(res, { loggedOut: true });
};

export const me: RequestHandler = async (req, res) => {
  ok(res, await authService.getCurrentUser(requireAuth(req).userId));
};

export const listSessions: RequestHandler = async (req, res) => {
  const sessions = await authService.listSessions(requireAuth(req).userId);
  ok(res, sessions);
};

export const revokeSession: RequestHandler = async (req, res) => {
  const { id } = req.params as { id: string };
  await authService.revokeSession(requireAuth(req).userId, id);
  ok(res, { revoked: true });
};

export const changePassword: RequestHandler = async (req, res) => {
  const auth = requireAuth(req);
  const { currentPassword, newPassword } = req.body as {
    currentPassword: string;
    newPassword: string;
  };

  await authService.changePassword(auth.userId, currentPassword, newPassword);

  // Every session died, including this one — the client must log in again.
  clearRefreshCookie(res);
  ok(res, { passwordChanged: true, reauthenticationRequired: true });
};

/**
 * Forgot password — unauthenticated. The response is DELIBERATELY the same whether or not the email
 * belongs to an account: anything else lets an anonymous caller learn who has a login here. The
 * service does the work only for a real, active account; this handler always says the same sentence.
 */
export const forgotPassword: RequestHandler = async (req, res) => {
  const { email } = req.body as { email: string };
  await authService.requestPasswordReset(email);
  ok(res, { message: "If that account exists, we've sent a reset link to its email." });
};

/**
 * Reset password from an emailed link — unauthenticated. A valid, unspent, unexpired token sets the
 * new password and logs every device out; anything else is a 400 with a "request a new link" hint.
 */
export const resetPassword: RequestHandler = async (req, res) => {
  const { token, newPassword } = req.body as { token: string; newPassword: string };
  await authService.resetPassword(token, newPassword);

  // No session is created here — the user signs in fresh with the new password, which is also the
  // proof the reset worked. Clear any stale refresh cookie so the login screen starts clean.
  clearRefreshCookie(res);
  ok(res, { passwordReset: true });
};

export const setupMfa: RequestHandler = async (req, res) => {
  ok(res, await authService.setupMfa(requireAuth(req).userId));
};

export const activateMfa: RequestHandler = async (req, res) => {
  const { code } = req.body as { code: string };
  ok(res, await authService.activateMfa(requireAuth(req).userId, code));
};

export const verifyMfa: RequestHandler = async (req, res) => {
  const { mfaToken, code } = req.body as { mfaToken: string; code: string };
  respondWithTokens(res, await authService.verifyMfaChallenge(mfaToken, code, deviceInfo(req)));
};

export const disableMfa: RequestHandler = async (req, res) => {
  const { password } = req.body as { password: string };
  await authService.disableMfa(requireAuth(req).userId, password);
  ok(res, { mfaEnabled: false });
};
