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
} from "@medicore/api-client";
import { browserApi } from "../lib/api";

interface AuthState {
  user: AuthenticatedUser | null;
  permissions: string[];
  /** True until the first refresh attempt settles — render nothing sensitive before then. */
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<LoginResult>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
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

  const api = useMemo(() => browserApi(() => accessToken.current), []);

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
            const pair = await api.refresh();
            accessToken.current = pair.accessToken;
            scheduleRefresh(pair.expiresIn);
          } catch {
            // The family is gone (logout elsewhere, reuse detected, expiry).
            accessToken.current = undefined;
            setState({ user: null, permissions: [], loading: false });
            router.replace("/login?reason=expired");
          }
        })();
      }, delay);
    },
    [api, router],
  );

  const adopt = useCallback(
    async (pair: { accessToken: string; expiresIn: number; user: AuthenticatedUser }) => {
      accessToken.current = pair.accessToken;
      scheduleRefresh(pair.expiresIn);

      // Only `/auth/me` carries the permission list the UI needs for menu gating —
      // it is deliberately absent from the login response and from the token.
      const me = await api.me().catch(() => pair.user);
      setState({ user: me, permissions: me.permissions ?? [], loading: false });
    },
    [api, scheduleRefresh],
  );

  // Bootstrap: turn the cookie into a session, or conclude there isn't one.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const pair = await api.refresh();
        if (!cancelled) await adopt(pair);
      } catch {
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

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      // A failed logout must still clear the client. Leaving a user "logged in"
      // on screen because the network blipped is the worst possible outcome.
      if (!(err instanceof ApiClientError)) throw err;
    } finally {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      accessToken.current = undefined;
      setState({ user: null, permissions: [], loading: false });
      router.replace("/login");
    }
  }, [api, router]);

  const refreshUser = useCallback(async () => {
    const me = await api.me();
    setState((s) => ({ ...s, user: me, permissions: me.permissions ?? [] }));
  }, [api]);

  const can = useCallback(
    (permission: string) => state.permissions.includes(permission),
    [state.permissions],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, completeMfa, logout, can, refreshUser, api }),
    [state, login, completeMfa, logout, can, refreshUser, api],
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
