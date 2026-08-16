"use client";

/**
 * Client-side session (Doc 04 §3.2, ADR-0009).
 *
 * ── WHERE THE TOKENS LIVE, AND WHY ───────────────────────────────────────────
 * The access token is held in MEMORY — never in localStorage. Anything in
 * localStorage is readable by any script that gets onto the page, which turns one
 * XSS into a stolen session. On a page holding patient data that is not a
 * theoretical concern.
 *
 * The refresh token is in an httpOnly cookie, so JavaScript cannot read it at
 * all. The cost of memory-only is that a page reload loses the access token — so
 * on mount we silently exchange the cookie for a fresh one. That is the small
 * flash of "loading" you see on a hard refresh, and it is the correct trade.
 *
 * Authorization decisions are NOT made here. `permissions` gates what the UI
 * *shows*; the API independently refuses anything the user may not do. A tampered
 * client can reveal a menu item, never the data behind it (Constitution §3.6).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  ApiClientError,
  isMfaChallenge,
  type ApiClient,
  type AuthenticatedUser,
  type LoginResult,
  type TokenPair,
} from "@medicore/api-client";
import { browserApi } from "../lib/api";
import { getActiveBranchId } from "../lib/activeBranch";
import {
  DEV_MULTI_ACCOUNT,
  devRefreshToken,
  setDevRefreshToken,
  rememberAccount,
} from "../lib/devSession";

interface AuthState {
  user: AuthenticatedUser | null;
  permissions: string[];
  /** True until the first refresh attempt settles — render nothing sensitive before then. */
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<LoginResult>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  /** Ends the session server-side and clears the client. `redirectTo` overrides the default /login. */
  logout: (opts?: { redirectTo?: string }) => Promise<void>;
  /**
   * Drops THIS tab's session locally and leaves, without asking the server to end it.
   *
   * For the case where the server has already ended it and the client is catching up — a
   * password change revokes every session, this one included. Forgetting to call it leaves the
   * app *believing* it is signed in (see `logout` for what "believing" costs).
   */
  endSession: (redirectTo?: string) => void;
  /** Does the user hold this permission? UI gating only — never a security boundary. */
  can: (permission: string) => boolean;
  refreshUser: () => Promise<void>;
  /** The authenticated client. It reads the in-memory token on every call. */
  api: ApiClient;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ user: null, permissions: [], loading: true });

  // In a ref, not state: the API client reads it on every request, and we must
  // never re-render just because a token rotated.
  const accessToken = useRef<string | undefined>(undefined);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Shared in-flight recovery, so a burst of 401s (a page firing several calls at once when the
  // token has expired) triggers ONE silent refresh, not one per request.
  const recovering = useRef<Promise<boolean> | null>(null);
  // The API client is created once; it reaches the current 401 handler through this ref rather
  // than being rebuilt whenever the handler's closure changes.
  const onUnauthorizedRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  // The bootstrap refresh, held so React 18 StrictMode's double-invoked mount effect SHARES one
  // request instead of spending a rotating token twice — the second spend would look like token
  // reuse and burn the whole family, logging the user out on every reload.
  const bootstrap = useRef<Promise<TokenPair> | null>(null);

  const api = useMemo(
    () =>
      browserApi(
        () => accessToken.current,
        () => onUnauthorizedRef.current(),
        // The active branch is read live on every request (ADR-0015), so switching branch takes
        // effect without rebuilding the client — the same pattern as the access token.
        () => getActiveBranchId(),
      ),
    [],
  );

  /**
   * Schedules a silent refresh shortly BEFORE the access token expires, so a user
   * mid-consultation never sees a session error they could not have predicted.
   */
  const scheduleRefresh = useCallback(
    (expiresIn: number) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      const leadSeconds = 60;
      const delay = Math.max(10, expiresIn - leadSeconds) * 1000;

      refreshTimer.current = setTimeout(() => {
        void (async () => {
          try {
            const stored = devRefreshToken();
            // Dev: this tab's session lives ONLY in its own token — never the shared cookie (see
            // the bootstrap note). If it is gone, the tab is logged out; do not silently adopt
            // whatever account the cookie now points at. Production keeps the cookie flow.
            if (DEV_MULTI_ACCOUNT && !stored) throw new Error("no per-tab session token");
            // In dev, refresh from THIS tab's own token (body) so tabs don't share an account;
            // in production `stored` is undefined and the httpOnly cookie is used.
            const pair = await api.refresh(stored);
            accessToken.current = pair.accessToken;
            setDevRefreshToken(pair.refreshToken);
            scheduleRefresh(pair.expiresIn);
          } catch {
            // The family is gone (logout elsewhere, reuse detected, expiry).
            accessToken.current = undefined;
            setDevRefreshToken(undefined);
            setState({ user: null, permissions: [], loading: false });
            router.replace("/login?reason=expired");
          }
        })();
      }, delay);
    },
    [api, router],
  );

  /**
   * The API client calls this when a request comes back with an expired/invalid session
   * (HMS-AUTH-002/003) — the case the proactive timer misses when a machine sleeps past the
   * token's life. We try ONE silent refresh and let the request replay; if the refresh token
   * is gone too, the session is genuinely over, so we clear it and send the user to a login
   * form that says why, rather than leaving a dead "could not load" page on screen.
   */
  const handleUnauthorized = useCallback(async (): Promise<boolean> => {
    const inflight = (recovering.current ??= (async () => {
      try {
        const stored = devRefreshToken();
        if (DEV_MULTI_ACCOUNT && !stored) throw new Error("no per-tab session token");
        const pair = await api.refresh(stored);
        accessToken.current = pair.accessToken;
        setDevRefreshToken(pair.refreshToken);
        scheduleRefresh(pair.expiresIn);
        return true;
      } catch {
        accessToken.current = undefined;
        setDevRefreshToken(undefined);
        setState({ user: null, permissions: [], loading: false });
        router.replace("/login?reason=expired");
        return false;
      }
    })());
    try {
      return await inflight;
    } finally {
      if (recovering.current === inflight) recovering.current = null;
    }
  }, [api, scheduleRefresh, router]);
  onUnauthorizedRef.current = handleUnauthorized;

  const adopt = useCallback(
    async (pair: {
      accessToken: string;
      expiresIn: number;
      user: AuthenticatedUser;
      /** Present on login/refresh/mfa responses; used only for dev per-tab sessions. */
      refreshToken?: string;
    }) => {
      accessToken.current = pair.accessToken;
      // Dev-only: this tab now owns this account's refresh token (no-op in production).
      setDevRefreshToken(pair.refreshToken);
      scheduleRefresh(pair.expiresIn);

      // Only `/auth/me` carries the permission list the UI needs for menu gating —
      // it is deliberately absent from the login response and from the token.
      const me = await api.me().catch(() => pair.user);
      setState({ user: me, permissions: me.permissions ?? [], loading: false });
      // Dev-only: offer this account as a one-click sign-in next time (no-op in production).
      rememberAccount({ email: me.email, name: me.name, role: me.roles[0] });
    },
    [api, scheduleRefresh],
  );

  // Bootstrap: revive this tab's session, or conclude there isn't one.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const stored = devRefreshToken();
        /**
         * ── DEV PER-TAB MODE: NEVER FALL BACK TO THE SHARED COOKIE ────────────────
         * A tab with no stored token is a LOGGED-OUT tab, full stop. It must not call refresh
         * with an empty body, because the server would then use the httpOnly cookie — which is
         * shared by every tab of this browser and holds whichever account logged in LAST. A new
         * tab reviving from it would rotate (spend) that token, and the tab that actually owns
         * it would later present the now-spent token, trip reuse-detection, and be logged out.
         * That is the "logging in over here signs me out over there" bug. So: no session token
         * in this tab means show login, and each tab logs in independently. Production is
         * unaffected — `devRefreshToken()` is always undefined there, so the cookie flow below
         * runs exactly as before.
         */
        if (DEV_MULTI_ACCOUNT && !stored) {
          if (!cancelled) setState({ user: null, permissions: [], loading: false });
          return;
        }
        // Reuse an in-flight bootstrap so a StrictMode remount does not fire a second refresh.
        bootstrap.current ??= api.refresh(stored);
        const pair = await bootstrap.current;
        if (!cancelled) await adopt(pair);
      } catch {
        bootstrap.current = null;
        if (!cancelled) setState({ user: null, permissions: [], loading: false });
      }
    })();

    return () => {
      cancelled = true;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [api, adopt]);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const result = await api.login(email, password, navigator.userAgent);
      // An MFA challenge is NOT a session — the caller must complete it first.
      if (!isMfaChallenge(result)) await adopt(result);
      return result;
    },
    [api, adopt],
  );

  const completeMfa = useCallback(
    async (mfaToken: string, code: string) => {
      await adopt(await api.verifyMfa(mfaToken, code));
    },
    [api, adopt],
  );

  /**
   * The client half of signing out: forget the token, forget the user, go.
   *
   * Split out from `logout` because it is the whole of what some callers need. A password change
   * revokes every session SERVER-side; the tab that did it is already signed out and simply does
   * not know yet. Clearing state is not a formality there — while `user` is still set the app
   * renders as signed in, and the in-memory access token keeps working until it expires, so the
   * sign-out only becomes visible on some later request's 401. That was the "it redirects, but
   * only when I click something else" bug.
   */
  const endSession = useCallback(
    (redirectTo = "/login") => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      accessToken.current = undefined;
      // Dev-only: drop THIS tab's stored session so a reload does not revive it.
      setDevRefreshToken(undefined);
      setState({ user: null, permissions: [], loading: false });
      router.replace(redirectTo);
    },
    [router],
  );

  const logout = useCallback(
    async (opts?: { redirectTo?: string }) => {
      try {
        await api.logout();
      } catch (err) {
        // A failed logout must still clear the client. Leaving a user "logged in"
        // on screen because the network blipped is the worst possible outcome.
        if (!(err instanceof ApiClientError)) throw err;
      } finally {
        endSession(opts?.redirectTo);
      }
    },
    [api, endSession],
  );

  const refreshUser = useCallback(async () => {
    const me = await api.me();
    setState((s) => ({ ...s, user: me, permissions: me.permissions ?? [] }));
  }, [api]);

  const can = useCallback(
    (permission: string) => state.permissions.includes(permission),
    [state.permissions],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, completeMfa, logout, endSession, can, refreshUser, api }),
    [state, login, completeMfa, logout, endSession, can, refreshUser, api],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** The authenticated API client. Reads the in-memory access token on every call. */
export function useApi(): ApiClient {
  return useAuth().api;
}
