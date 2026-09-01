/**
 * The session lifecycle (M0 §5).
 *
 *   login ─▶ store refresh token securely ─▶ access token in memory ─▶ /auth/me
 *         ─▶ /me/branches ─▶ restore a VALID branch ─▶ enter the app
 *
 * Three properties here are correctness, not polish, and each has a test:
 *
 *  1. **Refresh is single-flight.** Refresh tokens ROTATE and the server detects reuse by revoking
 *     the whole family (ADR-0009, HMS-AUTH-003). Two concurrent 401s that each call `/auth/refresh`
 *     with the same stored token would look exactly like theft — the second one revokes the family
 *     and signs the user out mid-round. So every caller awaits ONE in-flight refresh.
 *
 *  2. **Logout always completes locally.** The server calls are best-effort inside a `try`; the
 *     wipe is in the `finally`. A sign-out that silently does nothing because there was no signal
 *     is worse than no sign-out button, because it is trusted.
 *
 *  3. **The access token is never persisted.** A cold start reads only the refresh token and
 *     exchanges it. That one round trip is the price of not leaving a bearer credential on disk.
 */
import { ApiClient, isMfaChallenge, type LoginResult, type TokenPair } from "@medicore/api-client";
import type { SessionStore } from "../state/session";
import type { SecureStorage } from "./storage";
import { storageKeys } from "./storage";

/** Why a session ended — the app shows a different message for each. */
export type SessionEndReason =
  | "userSignedOut"
  /** The refresh token was rejected or gone. Ordinary expiry. */
  | "expired"
  /** Reuse detection revoked the family (HMS-AUTH-003) — say so; the user's other devices died too. */
  | "revoked";

/**
 * How long before expiry the proactive refresh fires. Sixty seconds is enough for a slow mobile
 * round trip while still being far inside a 15-minute token's life.
 */
export const PROACTIVE_REFRESH_LEAD_MS = 60_000;

/**
 * The budget for the two best-effort calls during sign-out. Deliberately far shorter than the
 * normal 15 s: a sign-out that appears to hang is one the user force-quits, and force-quitting
 * skips the local wipe entirely — the opposite of what they asked for.
 */
export const LOGOUT_TIMEOUT_MS = 3_000;

export interface AuthController {
  /** Password sign-in. Returns the union so the caller must handle the MFA branch. */
  signIn(email: string, password: string, device: string): Promise<LoginResult>;
  /** Second factor. */
  completeMfa(mfaToken: string, code: string): Promise<TokenPair>;
  /** Cold start: exchange a stored refresh token for a session. False when there is none. */
  resume(): Promise<boolean>;
  /** The api-client's `onUnauthorized` hook. Single-flight. */
  refreshOnce(): Promise<boolean>;
  /** Sign out. Resolves once the LOCAL wipe is done, whatever the network did. */
  signOut(): Promise<void>;
  /** Milliseconds until the proactive refresh should fire, or undefined when not applicable. */
  msUntilRefresh(now?: number): number | undefined;
}

export interface AuthControllerDeps {
  api: ApiClient;
  store: SessionStore;
  secureStore: SecureStorage;
  slug: string;
  /** Everything a sign-out must also clear: query cache, branch store, navigation. */
  onSessionEnded: (reason: SessionEndReason) => void;
  /** Runs after a token pair is established — `/auth/me` plus the branch load. */
  bootstrap: () => Promise<void>;
  now?: () => number;
}

export function createAuthController(deps: AuthControllerDeps): AuthController {
  const { api, store, secureStore, slug } = deps;
  const now = deps.now ?? Date.now;
  const refreshKey = storageKeys.refreshToken(slug);

  /** The single in-flight refresh, shared by every caller that arrives while it runs. */
  let inFlight: Promise<boolean> | undefined;

  async function adopt(pair: TokenPair): Promise<void> {
    // Secure storage FIRST. If the write fails we have not yet told the app it is signed in, so
    // the failure surfaces as a failed login rather than as a session that dies at the next
    // cold start with no explanation.
    await secureStore.set(refreshKey, pair.refreshToken);
    store.getState().setTokens(pair.accessToken, pair.expiresIn, now());
    store.getState().setUser(pair.user);
  }

  async function endSession(reason: SessionEndReason): Promise<void> {
    // `remove` can reject on a locked device. A failure to clear must not stop the rest of the
    // wipe — the in-memory state is what an attacker with the unlocked phone would reach first.
    await secureStore.remove(refreshKey).catch(() => undefined);
    store.getState().signedOut();
    deps.onSessionEnded(reason);
  }

  /** Best-effort with a hard ceiling. The request may still be in flight; for a logout that is fine. */
  async function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
    /**
     * The timer handle is never annotated, deliberately. React Native's global `setTimeout`
     * returns a `number` and Node's returns a `Timeout`, and which one a file sees depends on
     * whose type definitions won — it changed under us on an SDK downgrade and broke the build.
     * Letting `handle` be inferred at the call site and closing over `clearTimeout` keeps this
     * correct on both, with no `as` and no platform branch.
     */
    let cancel = (): void => {};
    const expiry = new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, ms);
      cancel = () => clearTimeout(handle);
    });

    try {
      await Promise.race([work, expiry]);
    } finally {
      cancel();
    }
  }

  async function performRefresh(): Promise<boolean> {
    const stored = await secureStore.get(refreshKey).catch(() => undefined);
    if (!stored) {
      await endSession("expired");
      return false;
    }

    try {
      const pair = await api.refresh(stored);
      await adopt(pair);
      return true;
    } catch (error) {
      /**
       * A rejected refresh is terminal — there is no second credential to try. The distinction
       * that matters to the user is WHY: an ordinary expiry is unremarkable, whereas a revoked
       * family means their other devices were signed out too and they should know.
       */
      const code = (error as { code?: string }).code;
      await endSession(code === "HMS-AUTH-003" ? "revoked" : "expired");
      return false;
    }
  }

  return {
    async signIn(email, password, device) {
      const result = await api.login(email, password, device);
      if (isMfaChallenge(result)) return result;
      await adopt(result);
      await deps.bootstrap();
      return result;
    },

    async completeMfa(mfaToken, code) {
      const pair = await api.verifyMfa(mfaToken, code);
      await adopt(pair);
      await deps.bootstrap();
      return pair;
    },

    async resume() {
      const stored = await secureStore.get(refreshKey).catch(() => undefined);
      if (!stored) {
        store.getState().signedOut();
        return false;
      }
      const refreshed = await performRefresh();
      if (!refreshed) return false;
      await deps.bootstrap();
      return true;
    },

    refreshOnce() {
      // The single-flight gate. Note it is set BEFORE the first await inside `performRefresh`, so
      // there is no window in which two callers both see `undefined`.
      inFlight ??= performRefresh().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },

    async signOut() {
      const hadSession = store.getState().status === "signedIn";
      try {
        if (hadSession) {
          /**
           * Best effort, and ordered: the device row goes first once M4 registers one, because a
           * token left registered pushes patient data to a phone somebody else is now holding.
           * There is no device to delete in M1, so this is the logout call alone.
           */
          await withTimeout(
            api.logout().catch(() => undefined),
            LOGOUT_TIMEOUT_MS,
          );
        }
      } finally {
        // ALWAYS. Offline, API down, 401 — the local wipe is not conditional on any of it.
        await endSession("userSignedOut");
      }
    },

    msUntilRefresh(at = now()) {
      const { expiresAt, status } = store.getState();
      if (status !== "signedIn" || expiresAt === undefined) return undefined;
      return Math.max(0, expiresAt - PROACTIVE_REFRESH_LEAD_MS - at);
    },
  };
}
