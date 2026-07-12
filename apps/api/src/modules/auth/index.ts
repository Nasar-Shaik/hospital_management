/**
 * Auth module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5).
 *
 * Other modules import ONLY from this file. The repository, the models and the
 * controller are private: nothing outside this folder may read `credentials` or
 * `refreshTokens`, which is what makes "where can a password hash be touched?"
 * a question with a one-folder answer.
 *
 * Depends on: `users`, `rbac` (both platform modules). Depended on by: the
 * composition root (route mounting) and, from Phase 1C, `authorize`.
 *
 * Platform module (PLATFORM_STRATEGY §2) — no healthcare vocabulary.
 */
export { authRouter } from "./auth.routes.js";

export {
  login,
  refresh,
  logout,
  listSessions,
  revokeSession,
  revokeAllSessions,
  setPassword,
  changePassword,
  setupMfa,
  activateMfa,
  verifyMfaChallenge,
  disableMfa,
  assertMfaEnrolled,
  getCurrentUser,
  isMfaChallenge,
  type AuthenticatedUser,
  type TokenPair,
  type MfaChallenge,
  type LoginResult,
  type DeviceInfo,
  type Session,
} from "./auth.service.js";
