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
import type { ApiEnvelope } from "@medicore/types";
import { env } from "../../config/env.js";
import { requireAuth } from "../../middleware/authenticate.js";
import { SessionExpiredError } from "../../core/errors/appError.js";
import * as authService from "./auth.service.js";
import type { DeviceInfo, LoginResult, TokenPair } from "./auth.service.js";

const REFRESH_COOKIE = "hms_refresh";

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiEnvelope<T> = { success: true, data };
  res.status(status).json(body);
}

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
    path: "/api/v1/auth",
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
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

export const refresh: RequestHandler = async (req, res) => {
  const token = presentedRefreshToken(req);
  if (!token) {
    // Same error a bad token gets — an absent cookie is not more informative.
    throw new SessionExpiredError({ reason: "no refresh token presented" });
  }
  respondWithTokens(res, await authService.refresh(token, deviceInfo(req)));
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
